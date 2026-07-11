/**
 * Cross-platform OAuth token refresh for Claude Code credentials.
 *
 * Storage backends:
 *   macOS  — system Keychain via /usr/bin/security (no prompt — pre-authorised)
 *   Linux  — ~/.claude/.credentials.json
 *
 * The credential store is dependency-injectable for testing. Production code
 * uses createPlatformCredentialStore() which picks the right backend
 * automatically.
 *
 * Concurrent calls to refreshOAuthToken() are deduplicated: if a refresh is
 * already in flight, subsequent callers wait for the same promise rather than
 * issuing a second network request and racing on the write.
 */

import { execFile as execFileCb } from "child_process"
import {
  closeSync,
  existsSync,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeSync,
} from "fs"
import { homedir, platform, userInfo } from "os"
import { basename, join, dirname, resolve } from "path"
import { createHash } from "crypto"
import { promisify } from "util"
import { claudeLog } from "../logger"

const execFile = promisify(execFileCb)

const OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token"
const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
const KEYCHAIN_SERVICE = "Claude Code-credentials"
const CREDENTIALS_FILE = `${homedir()}/.claude/.credentials.json`
const DEFAULT_CLAUDE_DIR = `${homedir()}/.claude`

/**
 * Map a `claudeConfigDir` to the keychain service name claude-code uses
 * for that directory.
 *
 * Default `~/.claude` uses the bare service name `Claude Code-credentials`.
 * Any other directory uses `Claude Code-credentials-<sha256(absPath).slice(0,8)>` —
 * matching claude-code's own convention so we can read OAuth tokens for
 * additional Meridian profiles without prompting the user.
 */
export function configDirToKeychainService(claudeConfigDir: string): string {
  const abs = resolve(claudeConfigDir)
  if (abs === resolve(DEFAULT_CLAUDE_DIR)) return KEYCHAIN_SERVICE
  const hash = createHash("sha256").update(abs).digest("hex").slice(0, 8)
  return `${KEYCHAIN_SERVICE}-${hash}`
}

/** Map `claudeConfigDir` to the file-based credentials path. */
export function configDirToCredentialsFile(claudeConfigDir: string): string {
  return join(resolve(claudeConfigDir), ".credentials.json")
}

interface OAuthCredentials {
  accessToken: string
  refreshToken: string
  expiresAt: number
  // PATCHED: NoWayLM — rotation 附帶的 refresh chain 效期；不跟著展延會凍在
  // provisioning 當下，host verify gate 會在舊效期到點時誤判登入鏈自然到期。
  refreshTokenExpiresAt?: number
  scopes?: string[]
  subscriptionType?: string
  rateLimitTier?: string
}

interface CredentialsFile {
  claudeAiOauth: OAuthCredentials
  [key: string]: unknown
}

// ---------------------------------------------------------------------------
// Credential store interface — injectable for testing
// ---------------------------------------------------------------------------

export interface CredentialStore {
  read(): Promise<CredentialsFile | null>
  write(credentials: CredentialsFile): Promise<boolean>
  /** PATCHED: NoWayLM — file-backed store 暴露路徑，refresh 據此對 host 共用 lock 上鎖。 */
  readonly credentialFilePath?: string
}

/**
 * Serialize a credentials object to the on-disk / Keychain format Claude Code
 * expects.
 *
 * MUST be compact (no whitespace) — Claude Code's credential parser cannot
 * read pretty-printed JSON and treats the user as logged out when it
 * encounters one. See issue #452.
 *
 * Exported so the regression test can pin the output format directly.
 */
export function serializeCredentials(credentials: CredentialsFile): string {
  return JSON.stringify(credentials)
}

// ---------------------------------------------------------------------------
// PATCHED: NoWayLM — cross-process credential lock + realpath-aware atomic write
//
// 所有 NoWayLM / Whisk container 與 host keepwarm / 顯式 provisioning 共用同一份
// rw bind mount 的 rotating refresh token。refresh 為單次輪替：兩個 writer 拿同一顆
// refresh token 同時打 OAuth endpoint，後到者 invalid_grant、甚至把 stale 內容寫回
// 蓋掉 successor → chain 燒毀、只能全站停機人工 re-provision。因此：
//   1. 消耗 refresh token 前必須取得 credentials「真實路徑」目錄下的 `.keepwarm.lock`
//      （mkdir 原子鎖；與 host scripts 同名、同 primitive、同 inode — 容器內
//      ~/.claude/.credentials.json 是 symlink 到 /app/claude-creds/，鎖必須跟著
//      realpath 走才能跨 container / host 互斥）。
//   2. 取鎖後重讀：別的 writer 已完成 rotation 就直接採用 successor、不再打 API。
//   3. 等鎖逾時「不偷鎖」（對齊 host 政策：orphan lock 只走 runbook §4.7 人工盤點）；
//      逾時後讀到 successor 仍採用，否則放棄本輪、交背景排程稍後重試。
//   4. 檔案寫入改 tmp + fsync + rename 到 realpath（直接 rename 到 symlink 路徑會把
//      symlink 換成 container-local 檔案，host 永遠看不到 successor）。
// ---------------------------------------------------------------------------

const CREDENTIAL_LOCK_DIR_NAME = ".keepwarm.lock"
const CREDENTIAL_LOCK_WAIT_MS = 15_000
const CREDENTIAL_LOCK_POLL_MS = 500

/** Resolve symlinks so lock + atomic rename land on the real (host-shared) file. */
function resolveCredentialTargetPath(filePath: string): string {
  try {
    return realpathSync(filePath)
  } catch {
    try {
      return join(realpathSync(dirname(filePath)), basename(filePath))
    } catch {
      return resolve(filePath)
    }
  }
}

function credentialLockDirPathFor(filePath: string): string {
  return join(dirname(resolveCredentialTargetPath(filePath)), CREDENTIAL_LOCK_DIR_NAME)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

async function acquireCredentialLock(lockDirPath: string, maxWaitMs: number): Promise<boolean> {
  const deadline = Date.now() + maxWaitMs
  for (;;) {
    try {
      mkdirSync(lockDirPath)
      return true
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        claudeLog("token_refresh.lock_error", { lockDirPath, error: String(err) })
        return false
      }
    }
    if (Date.now() >= deadline) return false
    await sleep(CREDENTIAL_LOCK_POLL_MS)
  }
}

function releaseCredentialLock(lockDirPath: string): void {
  try {
    rmdirSync(lockDirPath)
  } catch (err) {
    // 放鎖失敗不可吞掉不記：orphan 會擋 host keepwarm；log 供 runbook §4.7 盤點。
    claudeLog("token_refresh.lock_release_failed", { lockDirPath, error: String(err) })
  }
}

function buildCredentialTempName(): string {
  return `.credentials.tmp.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2, 8)}`
}

// refresh token 是單次輪替：POST 成功後任何持久化失敗都會讓 successor 只存在記憶體。
// 因此 temp 建立、權限、64KiB 空間預留、fsync 全部移到 POST 之前完成；POST 之後只剩
// 「覆寫已預留的 fd + rename」這種幾乎不會失敗的步驟。
const CREDENTIAL_TEMP_RESERVE_BYTES = 64 * 1024

function prepareCredentialTemp(targetPath: string): { fd: number; path: string } {
  const temporaryPath = join(dirname(targetPath), buildCredentialTempName())
  const fd = openSync(temporaryPath, "wx", 0o600)
  try {
    writeBufferFully(fd, Buffer.alloc(CREDENTIAL_TEMP_RESERVE_BYTES, 0x20), 0)
    fsyncSync(fd)
    return { fd, path: temporaryPath }
  } catch (err) {
    try {
      closeSync(fd)
    } catch {}
    try {
      unlinkSync(temporaryPath)
    } catch {}
    throw err
  }
}

function writeBufferFully(fd: number, buffer: Buffer, filePosition: number): void {
  let offset = 0
  while (offset < buffer.length) {
    const written = writeSync(fd, buffer, offset, buffer.length - offset, filePosition + offset)
    if (written <= 0) throw new Error("short write while persisting credentials")
    offset += written
  }
}

/** 把 serialized credentials 落到已預留的 temp fd 並 rename 到 target（含 parent dir fsync）。 */
function commitSerializedCredentials(fd: number, temporaryPath: string, targetPath: string, serialized: string): void {
  const payload = Buffer.from(serialized, "utf-8")
  if (payload.length > CREDENTIAL_TEMP_RESERVE_BYTES) {
    // 超過預留空間的寫入會重新引入 post-POST ENOSPC 面；credentials 正常 ~2KiB，
    // 超過 64KiB 一定是異常 payload，直接走 commit 失敗（fail-closed）。
    throw new Error("serialized credentials exceed reserved temp capacity")
  }
  writeBufferFully(fd, payload, 0)
  try {
    // truncate 失敗不 abort：JSON.parse 容忍 trailing whitespace（對齊 host keepwarm）。
    ftruncateSync(fd, payload.length)
  } catch {}
  fsyncSync(fd)
  closeSync(fd)
  renameSync(temporaryPath, targetPath)
  try {
    const directoryFd = openSync(dirname(targetPath), "r")
    try {
      fsyncSync(directoryFd)
    } finally {
      closeSync(directoryFd)
    }
  } catch (err) {
    // parent dir fsync 失敗只降 durability（crash 才可能回退），rename 本身已成功。
    claudeLog("token_refresh.dir_fsync_failed", { targetPath, error: String(err) })
  }
}

// ---------------------------------------------------------------------------
// macOS Keychain backend
// ---------------------------------------------------------------------------
//
// Claude Code stores credentials as hex-encoded JSON in the Keychain after
// `claude login`. Older installs may store raw JSON. We detect on read and
// preserve the original encoding on write so Claude Code can always read back
// what we write.

function parseKeychainValue(raw: string): { credentials: CredentialsFile; wasHex: boolean } | null {
  const trimmed = raw.trim()
  // Try raw JSON first
  try {
    return { credentials: JSON.parse(trimmed) as CredentialsFile, wasHex: false }
  } catch {}
  // Try hex-decoded JSON (Claude Code's format after `claude login`)
  try {
    const decoded = Buffer.from(trimmed, "hex").toString("utf-8")
    return { credentials: JSON.parse(decoded) as CredentialsFile, wasHex: true }
  } catch {}
  return null
}

// Track encoding format across read → write within the same refresh call.
// Keyed by service name so per-profile stores don't clobber each other.
const keychainWasHexByService = new Map<string, boolean>()

function buildMacosStore(serviceName: string): CredentialStore {
  return {
    async read() {
      try {
        const { stdout } = await execFile(
          "/usr/bin/security",
          ["find-generic-password", "-s", serviceName, "-a", userInfo().username, "-w"],
          { timeout: 5000 }
        )
        const parsed = parseKeychainValue(stdout)
        if (!parsed) throw new Error("Could not parse keychain value as JSON or hex-encoded JSON")
        keychainWasHexByService.set(serviceName, parsed.wasHex)
        return parsed.credentials
      } catch (err) {
        claudeLog("token_refresh.keychain_read_failed", { service: serviceName, error: String(err) })
        return null
      }
    },

    async write(credentials) {
      const json = serializeCredentials(credentials)
      const wasHex = keychainWasHexByService.get(serviceName) ?? false
      // Write back in the same encoding Claude Code expects — hex after `claude login`.
      const value = wasHex ? Buffer.from(json).toString("hex") : json
      try {
        await execFile(
          "/usr/bin/security",
          ["add-generic-password", "-U", "-s", serviceName, "-a", userInfo().username, "-w", value],
          { timeout: 5000 }
        )
        return true
      } catch (err) {
        claudeLog("token_refresh.keychain_write_failed", { service: serviceName, error: String(err) })
        return false
      }
    },
  }
}

const macosStore: CredentialStore = buildMacosStore(KEYCHAIN_SERVICE)

// ---------------------------------------------------------------------------
// Linux / file backend
// ---------------------------------------------------------------------------

function buildFileStore(filePath: string): CredentialStore {
  return {
    async read() {
      try {
        if (!existsSync(filePath)) return null
        return JSON.parse(readFileSync(filePath, "utf-8")) as CredentialsFile
      } catch (err) {
        claudeLog("token_refresh.file_read_failed", { path: filePath, error: String(err) })
        return null
      }
    },

    async write(credentials) {
      // PATCHED: NoWayLM — tmp + fsync + rename 到 realpath；0600（host read-only gate 要求）。
      // refresh transaction（doRefresh）不走這條：它用 pre-POST 預建的 temp 走
      // commitCredentialsToTarget，把可失敗步驟移到 refresh token 被消耗之前。
      let temporaryPath: string | null = null
      let temporaryFd: number | null = null
      try {
        // Ensure parent dir exists for non-default paths.
        mkdirSync(dirname(filePath), { recursive: true })
        const targetPath = resolveCredentialTargetPath(filePath)
        temporaryPath = join(dirname(targetPath), buildCredentialTempName())
        temporaryFd = openSync(temporaryPath, "wx", 0o600)
        commitSerializedCredentials(temporaryFd, temporaryPath, targetPath, serializeCredentials(credentials))
        temporaryFd = null
        temporaryPath = null
        return true
      } catch (err) {
        claudeLog("token_refresh.file_write_failed", { path: filePath, error: String(err) })
        if (temporaryFd !== null) {
          try {
            closeSync(temporaryFd)
          } catch {}
        }
        if (temporaryPath) {
          try {
            unlinkSync(temporaryPath)
          } catch {}
        }
        return false
      }
    },

    credentialFilePath: filePath,
  }
}


const fileStore: CredentialStore = buildFileStore(CREDENTIALS_FILE)

/** PATCHED: NoWayLM — 測試跨 process lock 行為用（production 一律走 createPlatformCredentialStore）。 */
export function createFileCredentialStore(filePath: string): CredentialStore {
  return buildFileStore(filePath)
}

/**
 * Returns the appropriate credential store for the current platform.
 *
 * If `claudeConfigDir` is provided, returns a profile-specific store that
 * reads from the matching keychain entry (macOS) or `<dir>/.credentials.json`
 * (Linux). Default behaviour (no opts) is unchanged — reads from the
 * standard `~/.claude` location.
 */
export function createPlatformCredentialStore(opts?: { claudeConfigDir?: string }): CredentialStore {
  if (opts?.claudeConfigDir) {
    if (platform() === "darwin") {
      return buildMacosStore(configDirToKeychainService(opts.claudeConfigDir))
    }
    return buildFileStore(configDirToCredentialsFile(opts.claudeConfigDir))
  }
  return platform() === "darwin" ? macosStore : fileStore
}

/** Look up the appropriate file path for a profile (Linux convention even on macOS for inspection). */
export function credentialsFilePathForProfile(claudeConfigDir?: string): string {
  return claudeConfigDir ? configDirToCredentialsFile(claudeConfigDir) : CREDENTIALS_FILE
}

// ---------------------------------------------------------------------------
// OAuth refresh
// ---------------------------------------------------------------------------

/** In-flight refresh promise — deduplicates concurrent callers. */
let inflightRefresh: Promise<boolean> | null = null

/**
 * Refresh the Claude Code OAuth access token.
 *
 * Reads the stored refresh token, exchanges it for a new access token via
 * Anthropic's OAuth endpoint, and writes the updated credentials back.
 *
 * Returns true on success, false on any failure. Concurrent calls share one
 * in-flight request so only one network round-trip is made.
 *
 * @param store  Override the credential store (for testing).
 */
export async function refreshOAuthToken(
  store?: CredentialStore,
  lockWaitMs = CREDENTIAL_LOCK_WAIT_MS,
): Promise<boolean> {
  if (inflightRefresh) return inflightRefresh

  inflightRefresh = doRefresh(store ?? createPlatformCredentialStore(), lockWaitMs).finally(() => {
    inflightRefresh = null
  })

  return inflightRefresh
}

// PATCHED: NoWayLM — 判斷「等待期間別的 writer 是否已完成 refresh」：refresh token 已
// 輪替、或 access token 效期前移，都代表 successor 已落地、本輪不得再消耗舊 token。
//
// 已知限制（審查拍板接受）：這是 heuristic、無 lineage 證明。若 operator 違反 runbook
// 「禁止憑 backup 還原」把舊備份蓋回 live 檔，本函式會把它誤認 successor 而回報成功；
// 但那個還原動作本身已經毀鏈（live successor 被覆蓋消失），本函式只影響發現時point、
// 不是成因。writer 集合封閉（同機 keepwarm / Meridian / provisioning、共用時鐘），
// 引入 generation/receipt 協議需同步改兩 repo 全部 writer，超出規模效益。
function wasRefreshedByOtherWriter(before: CredentialsFile, after: CredentialsFile): boolean {
  const beforeOauth = before.claudeAiOauth
  const afterOauth = after.claudeAiOauth
  if (!afterOauth?.accessToken || !afterOauth.refreshToken) return false
  if (afterOauth.refreshToken !== beforeOauth.refreshToken) return true
  return (
    typeof afterOauth.expiresAt === "number" &&
    typeof beforeOauth.expiresAt === "number" &&
    afterOauth.expiresAt > beforeOauth.expiresAt
  )
}

async function doRefresh(store: CredentialStore, lockWaitMs: number): Promise<boolean> {
  const credentials = await store.read()
  if (!credentials) {
    claudeLog("token_refresh.no_credentials", {})
    return false
  }

  const { refreshToken } = credentials.claudeAiOauth
  if (!refreshToken) {
    claudeLog("token_refresh.no_refresh_token", {})
    return false
  }

  // PATCHED: NoWayLM — file-backed store 必須先取得 host 共用 .keepwarm.lock 才可
  // 消耗 rotating refresh token；keychain / 注入的測試 store 沒有共用檔案，維持原行為。
  // target realpath 在此解析一次並「釘住」整個 transaction：鎖、重讀、temp、rename
  // 全部用同一路徑，杜絕鎖住舊目錄卻寫新目錄的 divergence。
  const pinnedTargetPath = store.credentialFilePath
    ? resolveCredentialTargetPath(store.credentialFilePath)
    : null
  const lockDirPath = pinnedTargetPath
    ? join(dirname(pinnedTargetPath), CREDENTIAL_LOCK_DIR_NAME)
    : null
  if (!lockDirPath || !pinnedTargetPath) {
    // 已知限制（審查拍板接受）：keychain / 無檔案路徑 backend 沒有跨 process lock 可保留，
    // possibly-consumed 保護僅止於 process-local；此路徑只在「Meridian 直接跑於 macOS host」
    // 時存在（NoWayLM production 恆為 Linux 容器 file store），行為與 upstream 原生一致。
    return (await performRefresh(store, credentials, null)).ok
  }

  // 便宜加固：host 顯式 provisioning 兩階段之間若 SOP 違規（容器沒停乾淨），Meridian
  // 不得在 pending gate 存在時 rotate（會讓 keepwarm proof hash-mismatch、gate 卡死）。
  if (existsSync(join(dirname(pinnedTargetPath), ".provisioning-pending"))) {
    claudeLog("token_refresh.provisioning_pending_gate", { pinnedTargetPath })
    return false
  }

  if (!(await acquireCredentialLock(lockDirPath, lockWaitMs))) {
    // 不偷鎖：逾時後若別的 writer 已寫入 successor 就直接採用，否則放棄本輪
    //（背景排程 failureRetryMs 後重試），orphan lock 留給 runbook §4.7 人工盤點。
    const latest = await store.read()
    if (latest && wasRefreshedByOtherWriter(credentials, latest)) {
      claudeLog("token_refresh.adopted_external_refresh", { lockDirPath, afterLockTimeout: true })
      return true
    }
    claudeLog("token_refresh.lock_busy", { lockDirPath })
    return false
  }
  let retainLockForQuarantine = false
  try {
    // 取鎖後重解析 target：等鎖期間 symlink 被 retarget（如 re-provision 換佈局）
    // 代表鎖與目標已 divergence，放鎖退出、絕不消耗 refresh token。
    if (resolveCredentialTargetPath(store.credentialFilePath!) !== pinnedTargetPath) {
      claudeLog("token_refresh.target_retargeted", { pinnedTargetPath })
      return false
    }
    // 鎖內重讀「直接讀 pinned realpath」：不經 store（symlink 可變），使 compare 之後
    // 的 retarget 結構性無效 — 之後的讀 / temp / rename 全都只碰 pinned path。
    let current: CredentialsFile | null = null
    try {
      current = JSON.parse(readFileSync(pinnedTargetPath, "utf-8")) as CredentialsFile
    } catch (err) {
      claudeLog("token_refresh.pinned_read_failed", { pinnedTargetPath, error: String(err) })
      return false
    }
    if (!current?.claudeAiOauth?.refreshToken) {
      claudeLog("token_refresh.no_refresh_token", { afterLock: true })
      return false
    }
    if (wasRefreshedByOtherWriter(credentials, current)) {
      claudeLog("token_refresh.adopted_external_refresh", { lockDirPath })
      return true
    }
    const result = await performRefresh(store, current, pinnedTargetPath)
    retainLockForQuarantine = result.retainLock
    if (result.retainLock) {
      writeRefreshIncidentMarker(pinnedTargetPath, result.retainReason ?? "unknown")
    }
    return result.ok
  } finally {
    if (retainLockForQuarantine) {
      // rotation 已成功但 successor 落盤失敗：舊 token 已死、繼續讓其他 writer 重試
      // 只會空燒。保留 lock 讓 host keepwarm 的 orphan 告警把 operator 拉進 runbook。
      claudeLog("token_refresh.lock_retained_for_quarantine", { lockDirPath })
    } else {
      releaseCredentialLock(lockDirPath)
    }
  }
}

interface RefreshOutcome {
  ok: boolean
  /** rotation 成功但持久化失敗 — caller 必須保留 lock（fail-closed quarantine）。 */
  retainLock: boolean
  /** retainLock=true 時的事故原因（寫進 incident marker，不含任何 token）。 */
  retainReason?: string
}

// 事故訊號不能只靠 claudeLog（debug-only、需 env 才輸出）：retainLock 時在 credentials
// 目錄寫一顆不含 token 的 incident marker，operator 依 runbook §4.7 盤點 lock 時可直接
// grep 到原因，不會誤判成一般 orphan。best-effort：寫不進去仍以 retained lock 為主訊號。
function writeRefreshIncidentMarker(pinnedTargetPath: string, reason: string): void {
  try {
    const markerPath = join(dirname(pinnedTargetPath), `.credentials.refresh-incident.${Date.now()}`)
    const fd = openSync(markerPath, "wx", 0o600)
    try {
      writeBufferFully(fd, Buffer.from(`${new Date().toISOString()}|${reason}\n`, "utf-8"), 0)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    claudeLog("token_refresh.incident_marker_written", { markerPath, reason })
  } catch (err) {
    claudeLog("token_refresh.incident_marker_failed", { reason, error: String(err) })
  }
}

async function performRefresh(
  store: CredentialStore,
  credentials: CredentialsFile,
  pinnedTargetPath: string | null,
): Promise<RefreshOutcome> {
  const { refreshToken } = credentials.claudeAiOauth

  // PATCHED: NoWayLM — POST 會消耗一次性 refresh token；所有「可預防的失敗」（temp
  // 建立、權限、空間預留、fsync）都移到 POST 之前，失敗時 token 尚未消耗、安全退出。
  let preparedTemp: { fd: number; path: string } | null = null
  if (pinnedTargetPath) {
    try {
      mkdirSync(dirname(pinnedTargetPath), { recursive: true })
      preparedTemp = prepareCredentialTemp(pinnedTargetPath)
    } catch (err) {
      claudeLog("token_refresh.write_preflight_failed", { pinnedTargetPath, error: String(err) })
      return { ok: false, retainLock: false }
    }
  }
  const discardPreparedTemp = (): void => {
    if (!preparedTemp) return
    try {
      closeSync(preparedTemp.fd)
    } catch {}
    try {
      unlinkSync(preparedTemp.path)
    } catch {}
    preparedTemp = null
  }

  let response: Response
  try {
    response = await fetch(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        client_id: OAUTH_CLIENT_ID,
        refresh_token: refreshToken,
      }),
      signal: AbortSignal.timeout(15_000),
    })
  } catch (err) {
    discardPreparedTemp()
    claudeLog("token_refresh.request_failed", { error: String(err) })
    return { ok: false, retainLock: false }
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "")
    discardPreparedTemp()
    claudeLog("token_refresh.bad_response", { status: response.status, body })
    return { ok: false, retainLock: false }
  }

  let tokenData: {
    access_token: string
    refresh_token?: string
    expires_in?: number
    expires_at?: number
    refresh_token_expires_in?: number
  }
  try {
    tokenData = await response.json() as typeof tokenData
  } catch (err) {
    // HTTP 2xx 代表 server 已處理請求 — rotation 極可能已發生、successor 只存在於
    // 這個解析不了的 body 裡（已不可救）。fail-closed：保留 lock，避免任何 writer
    // 拿已消耗的 predecessor 重試（reuse 偵測可能連坐 revoke），讓 host keepwarm
    // orphan 告警把 operator 拉進 runbook。
    discardPreparedTemp()
    claudeLog("token_refresh.response_unparseable_possibly_consumed", { error: String(err) })
    return { ok: false, retainLock: true, retainReason: "response-unparseable-possibly-consumed" }
  }

  const now = Date.now()
  const expiresAt =
    tokenData.expires_at ??
    (tokenData.expires_in ? now + tokenData.expires_in * 1000 : now + 8 * 60 * 60 * 1000)

  credentials.claudeAiOauth = {
    ...credentials.claudeAiOauth,
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token ?? refreshToken,
    expiresAt,
  }

  // PATCHED: NoWayLM — rotation 附帶 refresh chain 新效期就一併展延（對齊 host keepwarm）；
  // 不展延會凍在 provisioning 當下、host verify gate 會提前 fail-closed 逼全站 re-provision。
  if (
    tokenData.refresh_token &&
    typeof tokenData.refresh_token_expires_in === "number" &&
    tokenData.refresh_token_expires_in > 0
  ) {
    credentials.claudeAiOauth.refreshTokenExpiresAt = now + tokenData.refresh_token_expires_in * 1000
  }

  if (!pinnedTargetPath || !preparedTemp) {
    // keychain / 無檔案路徑：沿用 store 自己的寫入。
    const written = await store.write(credentials)
    if (!written) return { ok: false, retainLock: false }
    claudeLog("token_refresh.success", { expiresAt })
    return { ok: true, retainLock: false }
  }

  const committingTemp = preparedTemp
  try {
    commitSerializedCredentials(
      committingTemp.fd,
      committingTemp.path,
      pinnedTargetPath,
      serializeCredentials(credentials),
    )
    preparedTemp = null
  } catch (err) {
    // rotation 已成功、successor 落盤失敗：舊 token 已被 server 作廢。temp 檔在失敗
    // 當下極可能已含完整 successor（write+fsync 先於 rename）—— 它就是唯一救援
    // artifact，「絕不刪除」，只關 fd、把路徑寫進 log；並要求 caller 保留 lock
    //（fail-closed；host keepwarm orphan 告警把 operator 拉進 runbook §4.7 的
    // successor-recovery 流程：驗 temp JSON → 手動轉正 → rmdir lock）。
    claudeLog("token_refresh.successor_persist_failed", {
      pinnedTargetPath,
      retainedTempPath: committingTemp.path,
      error: String(err),
    })
    try {
      closeSync(committingTemp.fd)
    } catch {}
    preparedTemp = null
    return { ok: false, retainLock: true, retainReason: "successor-persist-failed-temp-retained" }
  }

  claudeLog("token_refresh.success", { expiresAt })
  return { ok: true, retainLock: false }
}

/**
 * Refresh the access token if it is within `bufferMs` of expiry.
 *
 * Cheap to call before every SDK request: when the token isn't due yet this
 * is just one credential-store read. When it is due, the underlying
 * `refreshOAuthToken()` call is in-flight-deduplicated so concurrent callers
 * share one network round-trip.
 *
 * Returns true when the token is fresh after the call (already valid OR
 * successfully refreshed), false on any failure (no credentials, no
 * expiresAt, refresh request failed). False is non-fatal — the caller
 * proceeds with whatever token is on disk and falls back to the reactive
 * refresh-on-401 path if Anthropic rejects it.
 */
export async function ensureFreshToken(
  store?: CredentialStore,
  bufferMs = 5 * 60 * 1000,
): Promise<boolean> {
  const s = store ?? createPlatformCredentialStore()
  const credentials = await s.read()
  const expiresAt = credentials?.claudeAiOauth?.expiresAt
  if (!expiresAt) return false
  if (expiresAt - Date.now() > bufferMs) return true
  return refreshOAuthToken(s)
}

// ---------------------------------------------------------------------------
// Background refresh scheduler
// ---------------------------------------------------------------------------

let scheduledRefreshTimer: ReturnType<typeof setTimeout> | null = null
let scheduledRefreshActive = false
// Generation counter — bumped on every start/stop. Each scheduleNext chain
// captures the generation it began with and re-checks it after every await;
// if the global generation has moved on, the chain has been superseded and
// must bail rather than arm a follow-up timer. Without this, a stop()+start()
// that interleaves with an in-flight read leaves the first chain alive,
// arming a timer that overwrites scheduledRefreshTimer (so stop() can't
// clear it) and keeps firing in parallel with the live chain.
let scheduledRefreshGeneration = 0

/**
 * Start a self-rescheduling timer that refreshes the access token shortly
 * before each expiry — regardless of incoming traffic.
 *
 * Idempotent: a second call while one is already running is a no-op. Safe to
 * call from any code path; returns synchronously and schedules in the
 * background.
 *
 * Why traffic-independent matters: without this, an idle proxy never fires
 * either the proactive (`ensureFreshToken`) or reactive (401-retry) refresh
 * path. Anthropic's OAuth refresh tokens appear to be invalidated server-side
 * after sitting unused for an extended period (observed 2026-05-03: two NAS
 * instances idle past expiry both got `400 invalid_grant` on a manual refresh
 * attempt; only fix was OAuth-flow re-login). Running a refresh every ~8h
 * keeps the refresh chain warm.
 *
 * On `refreshOAuthToken()` failure (network, transient API error, refresh
 * token rejected) we retry every `failureRetryMs` — gives operators a window
 * to `claude login` and have the new tokens picked up automatically on the
 * next tick.
 */
export function startBackgroundRefresh(
  store?: CredentialStore,
  bufferMs = 5 * 60 * 1000,
  failureRetryMs = 5 * 60 * 1000,
): void {
  if (scheduledRefreshActive) return
  scheduledRefreshActive = true
  const gen = ++scheduledRefreshGeneration
  void scheduleNext(store ?? createPlatformCredentialStore(), bufferMs, failureRetryMs, gen)
}

/** Stop the background scheduler. Idempotent. */
export function stopBackgroundRefresh(): void {
  scheduledRefreshActive = false
  scheduledRefreshGeneration++
  if (scheduledRefreshTimer) clearTimeout(scheduledRefreshTimer)
  scheduledRefreshTimer = null
}

async function scheduleNext(
  store: CredentialStore,
  bufferMs: number,
  failureRetryMs: number,
  gen: number,
): Promise<void> {
  if (!scheduledRefreshActive || gen !== scheduledRefreshGeneration) return

  const credentials = await store.read().catch(() => null)
  if (!scheduledRefreshActive || gen !== scheduledRefreshGeneration) return

  const expiresAt = credentials?.claudeAiOauth?.expiresAt

  if (!expiresAt) {
    // Operator hasn't logged in yet (no credentials) or credentials are
    // missing the field. Re-poll periodically — once `claude login` writes
    // the file, the next tick picks it up.
    armTimer(failureRetryMs, store, bufferMs, failureRetryMs, gen)
    return
  }

  const dueIn = expiresAt - Date.now() - bufferMs
  if (dueIn <= 0) {
    // Already due (or past) — fire now, schedule the follow-up based on the
    // new expiresAt (or retry in failureRetryMs if refresh failed).
    const ok = await refreshOAuthToken(store)
    if (!scheduledRefreshActive || gen !== scheduledRefreshGeneration) return
    claudeLog("token_refresh.scheduled", { ok, immediate: true })
    console.error(`[token_refresh] scheduled refresh (immediate) ok=${ok}`)
    armTimer(ok ? 0 : failureRetryMs, store, bufferMs, failureRetryMs, gen)
    return
  }

  armTimer(dueIn, store, bufferMs, failureRetryMs, gen)
}

function armTimer(
  delayMs: number,
  store: CredentialStore,
  bufferMs: number,
  failureRetryMs: number,
  gen: number,
): void {
  scheduledRefreshTimer = setTimeout(async () => {
    if (!scheduledRefreshActive || gen !== scheduledRefreshGeneration) return
    // The dueIn re-check inside scheduleNext distinguishes "fire-now" from
    // "reschedule-only" ticks: when the disk-state recompute lands inside
    // the buffer window, scheduleNext emits the immediate-refresh log line;
    // otherwise it just arms the next timer silently.
    void scheduleNext(store, bufferMs, failureRetryMs, gen)
  }, delayMs)
  if (scheduledRefreshTimer && (scheduledRefreshTimer as { unref?: () => void }).unref) {
    (scheduledRefreshTimer as { unref: () => void }).unref()
  }
}

/** For testing only. */
export function isBackgroundRefreshActive(): boolean {
  return scheduledRefreshActive
}

/** Reset in-flight state — for testing only. */
export function resetInflightRefresh(): void {
  inflightRefresh = null
}
