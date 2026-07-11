/**
 * PATCHED: NoWayLM — cross-process credential lock + realpath-aware atomic write.
 *
 * 所有 container 與 host keepwarm 共用同一份 rotating refresh token；本 suite 驗證
 * tokenRefresh 在消耗 refresh token 前對 credentials realpath 目錄下的
 * `.keepwarm.lock`（與 host scripts 同名 mkdir 原子鎖）互斥、鎖內重讀採用 successor、
 * 等鎖逾時不偷鎖，且檔案寫入走 tmp+rename 到 realpath（不打斷 symlink）。
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "fs"
import { tmpdir } from "os"
import { join } from "path"
import {
  createFileCredentialStore,
  refreshOAuthToken,
  resetInflightRefresh,
} from "../proxy/tokenRefresh"

function mockFetch(fn: (...args: unknown[]) => Promise<Response>): void {
  globalThis.fetch = fn as typeof fetch
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

function makeCredentials(refreshToken = "original-refresh-token", expiresAt = Date.now() - 1000) {
  return {
    claudeAiOauth: {
      accessToken: "old-access-token",
      refreshToken,
      expiresAt,
      scopes: ["openid"],
      subscriptionType: "max",
    },
    extraField: "keep-me",
  }
}

function makeTokenResponse(overrides: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      access_token: "new-access-token",
      refresh_token: "rotated-refresh-token",
      expires_in: 28800,
      ...overrides,
    }),
    { status: 200 },
  )
}

const originalFetch = globalThis.fetch

// hostDir 模擬 host ~/.claude-openclaw（真實目錄、host scripts 上鎖處）；
// containerDir 模擬容器 ~/.claude，credentials 是 symlink（entrypoint.sh 佈局）。
let tempRoot: string
let hostDir: string
let containerDir: string
let hostCredentialPath: string
let credentialSymlinkPath: string
let hostLockDirPath: string

beforeEach(() => {
  resetInflightRefresh()
  tempRoot = mkdtempSync(join(tmpdir(), "meridian-credential-lock-"))
  hostDir = join(tempRoot, "claude-openclaw")
  containerDir = join(tempRoot, "claude")
  mkdirSync(hostDir, { recursive: true })
  mkdirSync(containerDir, { recursive: true })
  hostCredentialPath = join(hostDir, ".credentials.json")
  credentialSymlinkPath = join(containerDir, ".credentials.json")
  hostLockDirPath = join(hostDir, ".keepwarm.lock")
  writeFileSync(hostCredentialPath, JSON.stringify(makeCredentials()), { mode: 0o600 })
  symlinkSync(hostCredentialPath, credentialSymlinkPath)
})

afterEach(() => {
  globalThis.fetch = originalFetch
  resetInflightRefresh()
  rmSync(tempRoot, { recursive: true, force: true })
})

describe("cross-process credential lock (NoWayLM patch)", () => {
  it("refresh 經 symlink store：上鎖於 realpath 目錄、atomic 寫回 host 檔、symlink 不被打斷", async () => {
    let fetchCallCount = 0
    mockFetch(async () => {
      fetchCallCount++
      // fetch 期間鎖必須存在（critical section 內）
      expect(existsSync(hostLockDirPath)).toBe(true)
      return makeTokenResponse()
    })

    const store = createFileCredentialStore(credentialSymlinkPath)
    const ok = await refreshOAuthToken(store, 2000)

    expect(ok).toBe(true)
    expect(fetchCallCount).toBe(1)
    // 鎖已釋放
    expect(existsSync(hostLockDirPath)).toBe(false)
    // symlink 仍是 symlink（rename 落在 realpath，不是蓋掉 link）
    expect(lstatSync(credentialSymlinkPath).isSymbolicLink()).toBe(true)
    // host 檔已更新成 successor、0600、無 tmp 殘留
    const written = JSON.parse(readFileSync(hostCredentialPath, "utf-8"))
    expect(written.claudeAiOauth.refreshToken).toBe("rotated-refresh-token")
    expect(written.claudeAiOauth.accessToken).toBe("new-access-token")
    expect(written.extraField).toBe("keep-me")
    expect(statSync(hostCredentialPath).mode & 0o777).toBe(0o600)
    expect(readdirSync(hostDir).filter((name) => name.startsWith(".credentials.tmp."))).toHaveLength(0)
  })

  it("等鎖期間別的 writer 完成 rotation：取鎖後重讀採用 successor、不打 OAuth API", async () => {
    let fetchCallCount = 0
    mockFetch(async () => {
      fetchCallCount++
      return makeTokenResponse()
    })
    mkdirSync(hostLockDirPath)

    const store = createFileCredentialStore(credentialSymlinkPath)
    const refreshPromise = refreshOAuthToken(store, 5000)
    // 模擬 host keepwarm：寫入 successor 後放鎖
    await sleep(300)
    writeFileSync(
      hostCredentialPath,
      JSON.stringify(makeCredentials("successor-refresh-token", Date.now() + 8 * 3600 * 1000)),
      { mode: 0o600 },
    )
    rmdirSync(hostLockDirPath)

    expect(await refreshPromise).toBe(true)
    expect(fetchCallCount).toBe(0)
    // 採用 successor、未覆寫
    const remaining = JSON.parse(readFileSync(hostCredentialPath, "utf-8"))
    expect(remaining.claudeAiOauth.refreshToken).toBe("successor-refresh-token")
    expect(existsSync(hostLockDirPath)).toBe(false)
  })

  it("鎖被長期持有但 successor 已落地：等鎖逾時後採用、不偷鎖", async () => {
    let fetchCallCount = 0
    mockFetch(async () => {
      fetchCallCount++
      return makeTokenResponse()
    })
    mkdirSync(hostLockDirPath)

    const store = createFileCredentialStore(credentialSymlinkPath)
    const refreshPromise = refreshOAuthToken(store, 700)
    await sleep(200)
    // writer 寫了 successor 但一直沒放鎖（模擬持鎖中的 provisioning）
    writeFileSync(
      hostCredentialPath,
      JSON.stringify(makeCredentials("successor-refresh-token", Date.now() + 8 * 3600 * 1000)),
      { mode: 0o600 },
    )

    expect(await refreshPromise).toBe(true)
    expect(fetchCallCount).toBe(0)
    // 逾時路徑不得動別人的鎖
    expect(existsSync(hostLockDirPath)).toBe(true)
  })

  it("鎖被持有且無 successor：逾時放棄本輪、不打 API、不偷鎖", async () => {
    let fetchCallCount = 0
    mockFetch(async () => {
      fetchCallCount++
      return makeTokenResponse()
    })
    mkdirSync(hostLockDirPath)

    const store = createFileCredentialStore(credentialSymlinkPath)
    const ok = await refreshOAuthToken(store, 700)

    expect(ok).toBe(false)
    expect(fetchCallCount).toBe(0)
    expect(existsSync(hostLockDirPath)).toBe(true)
    // 原 credentials 未被動過
    const untouched = JSON.parse(readFileSync(hostCredentialPath, "utf-8"))
    expect(untouched.claudeAiOauth.refreshToken).toBe("original-refresh-token")
  })

  it("rotation 附帶 refresh_token_expires_in 時展延 refreshTokenExpiresAt", async () => {
    const ninetyDaysSeconds = 90 * 24 * 3600
    mockFetch(async () => makeTokenResponse({ refresh_token_expires_in: ninetyDaysSeconds }))
    const beforeRefreshMs = Date.now()

    const store = createFileCredentialStore(credentialSymlinkPath)
    const ok = await refreshOAuthToken(store, 2000)

    expect(ok).toBe(true)
    const written = JSON.parse(readFileSync(hostCredentialPath, "utf-8"))
    const expectedMinimum = beforeRefreshMs + ninetyDaysSeconds * 1000 - 60_000
    const expectedMaximum = Date.now() + ninetyDaysSeconds * 1000 + 60_000
    expect(written.claudeAiOauth.refreshTokenExpiresAt).toBeGreaterThanOrEqual(expectedMinimum)
    expect(written.claudeAiOauth.refreshTokenExpiresAt).toBeLessThanOrEqual(expectedMaximum)
  })

  it("等鎖期間 symlink 被 retarget：取鎖後偵測 divergence、不打 API、正常放鎖", async () => {
    let fetchCallCount = 0
    mockFetch(async () => {
      fetchCallCount++
      return makeTokenResponse()
    })
    // 先鎖住原 target 目錄，讓 doRefresh 進等待
    mkdirSync(hostLockDirPath)

    const store = createFileCredentialStore(credentialSymlinkPath)
    const refreshPromise = refreshOAuthToken(store, 5000)
    await sleep(300)
    // 模擬 re-provision：credentials symlink 改指到另一個目錄，然後放鎖
    const newHostDir = join(tempRoot, "claude-openclaw-new")
    mkdirSync(newHostDir, { recursive: true })
    const newHostCredentialPath = join(newHostDir, ".credentials.json")
    writeFileSync(
      newHostCredentialPath,
      JSON.stringify(makeCredentials("relocated-refresh-token", Date.now() - 1000)),
      { mode: 0o600 },
    )
    rmSync(credentialSymlinkPath)
    symlinkSync(newHostCredentialPath, credentialSymlinkPath)
    rmdirSync(hostLockDirPath)

    // pinned target 與取鎖後 realpath 不一致 → 放棄本輪、不消耗 refresh token
    expect(await refreshPromise).toBe(false)
    expect(fetchCallCount).toBe(0)
    // 原目錄的鎖已正常釋放（非 quarantine 保留）
    expect(existsSync(hostLockDirPath)).toBe(false)
  })

  it("rotation 成功但 successor 落盤失敗：quarantine 嘗試 + 保留 lock（fail-closed）", async () => {
    const { chmodSync } = await import("fs")
    let fetchCallCount = 0
    mockFetch(async () => {
      fetchCallCount++
      // POST「成功」的瞬間把 host 目錄設成唯讀 → rename 與 quarantine 都會失敗
      chmodSync(hostDir, 0o555)
      return makeTokenResponse()
    })

    const store = createFileCredentialStore(credentialSymlinkPath)
    const ok = await refreshOAuthToken(store, 2000)
    const lockStillHeld = existsSync(hostLockDirPath)
    chmodSync(hostDir, 0o755) // 先復原權限再斷言，讓 afterEach 能清理

    expect(ok).toBe(false)
    expect(fetchCallCount).toBe(1)
    // rotation 已成功而落盤失敗 → 鎖必須保留（讓 host orphan 告警拉人進 runbook）
    expect(lockStillHeld).toBe(true)
    // 舊 credentials 未被半截覆寫
    const untouched = JSON.parse(readFileSync(hostCredentialPath, "utf-8"))
    expect(untouched.claudeAiOauth.refreshToken).toBe("original-refresh-token")
    // temp 是唯一救援 artifact：必須保留、且內含完整 successor（runbook 據此救鏈）
    const retainedTempNames = readdirSync(hostDir).filter((name) =>
      name.startsWith(".credentials.tmp."),
    )
    expect(retainedTempNames).toHaveLength(1)
    const retainedTempContent = readFileSync(join(hostDir, retainedTempNames[0] ?? ""), "utf-8")
    expect(retainedTempContent).toContain("rotated-refresh-token")
    expect(JSON.parse(retainedTempContent).claudeAiOauth.accessToken).toBe("new-access-token")
    // 唯讀目錄下 incident marker 同失敗域寫不進去（best-effort）→ retained lock 是主訊號
    expect(
      readdirSync(hostDir).filter((name) => name.startsWith(".credentials.refresh-incident.")),
    ).toHaveLength(0)

    // retained lock 必須阻止後續 refresh 再消耗 token：第二次呼叫等鎖逾時 → false、
    // fetch 不再被打、lock 原封不動
    resetInflightRefresh()
    const secondAttempt = await refreshOAuthToken(store, 700)
    expect(secondAttempt).toBe(false)
    expect(fetchCallCount).toBe(1)
    expect(existsSync(hostLockDirPath)).toBe(true)
  })

  it("HTTP 2xx 但 body 解析失敗：視為可能已消耗 → 保留 lock + 寫 incident marker（無 token）", async () => {
    let fetchCallCount = 0
    mockFetch(async () => {
      fetchCallCount++
      return new Response("not-json-at-all", { status: 200 })
    })

    const store = createFileCredentialStore(credentialSymlinkPath)
    const ok = await refreshOAuthToken(store, 2000)

    expect(ok).toBe(false)
    expect(fetchCallCount).toBe(1)
    // 可能已消耗 → fail-closed 保留 lock
    expect(existsSync(hostLockDirPath)).toBe(true)
    // 舊 credentials 未被動
    const untouched = JSON.parse(readFileSync(hostCredentialPath, "utf-8"))
    expect(untouched.claudeAiOauth.refreshToken).toBe("original-refresh-token")
    // incident marker 已寫出：含原因、不含任何 token
    const incidentMarkerNames = readdirSync(hostDir).filter((name) =>
      name.startsWith(".credentials.refresh-incident."),
    )
    expect(incidentMarkerNames).toHaveLength(1)
    const incidentMarkerContent = readFileSync(join(hostDir, incidentMarkerNames[0] ?? ""), "utf-8")
    expect(incidentMarkerContent).toContain("response-unparseable-possibly-consumed")
    expect(incidentMarkerContent).not.toContain("original-refresh-token")
  })
})
