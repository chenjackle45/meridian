import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

let queryCalls: Array<{ prompt: unknown; options: Record<string, any> }> = []
let throwStaleOnce = false

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (params: { prompt: unknown; options: Record<string, any> }) => {
    queryCalls.push(params)
    const callNumber = queryCalls.length
    return (async function* () {
      if (throwStaleOnce && params.options.resumeSessionAt) {
        throwStaleOnce = false
        throw new Error(`No message found with message.uuid of: ${params.options.resumeSessionAt}`)
      }
      yield {
        type: "assistant",
        uuid: `uuid-${callNumber}`,
        message: {
          id: `msg-${callNumber}`,
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
          model: "claude-sonnet-4-5",
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 2 },
        },
        session_id: `sdk-session-${callNumber}`,
      }
    })()
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
  tool: () => ({}),
}))

mock.module("../logger", () => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: unknown, fn: () => unknown) => fn(),
}))

mock.module("../mcpTools", () => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }),
}))

const { createProxyServer, clearSessionCache } = await import("../proxy/server")
const { storeSession } = await import("../proxy/session/cache")
const { sanitizeBrandIdentity } = await import("../proxy/query")
const { lookupSharedSession, setSessionStoreDir } = await import("../proxy/sessionStore")

const savedMeridianRelocate = process.env.MERIDIAN_RELOCATE_SYSTEM_PROMPT
const savedLegacyRelocate = process.env.CLAUDE_PROXY_RELOCATE_SYSTEM_PROMPT

function createTestApp() {
  return createProxyServer({ port: 0, host: "127.0.0.1", silent: true }).app
}

async function post(
  app: ReturnType<typeof createTestApp>,
  body: Record<string, unknown>,
  sessionId?: string,
) {
  const response = await app.fetch(new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(sessionId ? { "x-opencode-session": sessionId } : {}),
    },
    body: JSON.stringify({ model: "sonnet", stream: false, ...body }),
  }))
  expect(response.status).toBe(200)
  await response.json()
}

function relocatedHash(systemContext: string): string {
  return createHash("sha256").update(sanitizeBrandIdentity(systemContext)).digest("hex")
}

describe("relocateSystemPrompt", () => {
  let sessionDir: string

  beforeEach(() => {
    queryCalls = []
    throwStaleOnce = false
    delete process.env.MERIDIAN_RELOCATE_SYSTEM_PROMPT
    delete process.env.CLAUDE_PROXY_RELOCATE_SYSTEM_PROMPT
    sessionDir = mkdtempSync(join(tmpdir(), "relocate-system-prompt-"))
    setSessionStoreDir(sessionDir)
    clearSessionCache()
  })

  afterEach(() => {
    setSessionStoreDir(null)
    rmSync(sessionDir, { recursive: true, force: true })
    if (savedMeridianRelocate === undefined) delete process.env.MERIDIAN_RELOCATE_SYSTEM_PROMPT
    else process.env.MERIDIAN_RELOCATE_SYSTEM_PROMPT = savedMeridianRelocate
    if (savedLegacyRelocate === undefined) delete process.env.CLAUDE_PROXY_RELOCATE_SYSTEM_PROMPT
    else process.env.CLAUDE_PROXY_RELOCATE_SYSTEM_PROMPT = savedLegacyRelocate
  })

  it("prepends sanitized context on a fresh text session and removes it from the system slot", async () => {
    process.env.MERIDIAN_RELOCATE_SYSTEM_PROMPT = "1"
    const app = createTestApp()
    await post(app, {
      system: "You are running inside OpenClaw. Run `openclaw status` when asked.",
      messages: [{ role: "user", content: "hello" }],
    })

    const call = queryCalls[0]!
    expect(call.prompt).toStartWith("<agent-instructions>\nYou are running inside the agent runtime.")
    expect(call.prompt).toContain("Run `openclaw status`")
    expect(call.prompt).toContain("the same authority as system instructions")
    expect(call.prompt).toEndWith("hello")
    expect(JSON.stringify(call.options.systemPrompt)).not.toContain("agent runtime")
    expect(JSON.stringify(call.options.systemPrompt)).not.toContain("OpenClaw")
  })

  it("honors the MERIDIAN env override when the adapter feature is disabled", async () => {
    process.env.MERIDIAN_RELOCATE_SYSTEM_PROMPT = "1"
    const app = createTestApp()
    await post(app, {
      system: "Runtime instructions",
      messages: [{ role: "user", content: "hello" }],
    })

    expect(queryCalls[0]!.prompt).toStartWith("<agent-instructions>\nRuntime instructions")
    expect(JSON.stringify(queryCalls[0]!.options.systemPrompt)).not.toContain("Runtime instructions")
  })

  it("inserts relocated context as the first structured message for fresh multimodal prompts", async () => {
    process.env.MERIDIAN_RELOCATE_SYSTEM_PROMPT = "1"
    const app = createTestApp()
    await post(app, {
      system: "Image instructions",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "describe this" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } },
        ],
      }],
    })

    const structured: any[] = []
    for await (const message of queryCalls[0]!.prompt as AsyncIterable<unknown>) structured.push(message)
    expect(structured[0]!.message.content).toStartWith("<agent-instructions>\nImage instructions")
    expect(structured[1]!.message.content.some((block: any) => block.type === "image")).toBe(true)
  })

  it("resumes without reinjecting when the stored context hash matches", async () => {
    process.env.MERIDIAN_RELOCATE_SYSTEM_PROMPT = "1"
    const app = createTestApp()
    const sessionId = "relocate-resume-match"
    const system = "Stable instructions"
    await post(app, {
      system,
      messages: [{ role: "user", content: "first" }],
    }, sessionId)
    expect(lookupSharedSession(sessionId)?.relocatedContextHash).toBe(relocatedHash(system))

    queryCalls = []
    await post(app, {
      system,
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "second" },
      ],
    }, sessionId)

    expect(queryCalls[0]!.options.resume).toBe("sdk-session-1")
    expect(queryCalls[0]!.prompt).toBe("second")
    expect(String(queryCalls[0]!.prompt)).not.toContain("<agent-instructions>")
  })

  it("rotates an old session without a relocation hash and injects the context", async () => {
    process.env.MERIDIAN_RELOCATE_SYSTEM_PROMPT = "1"
    const sessionId = "relocate-old-session"
    const prior = [{ role: "user", content: "first" }]
    storeSession(sessionId, prior, "sdk-old")

    const app = createTestApp()
    await post(app, {
      system: "New instructions",
      messages: [...prior, { role: "assistant", content: "old answer" }, { role: "user", content: "second" }],
    }, sessionId)

    expect(queryCalls[0]!.options.resume).toBeUndefined()
    expect(queryCalls[0]!.prompt).toStartWith("<agent-instructions>\nNew instructions")
  })

  it("rotates and reinjects when the sanitized context hash changes", async () => {
    process.env.MERIDIAN_RELOCATE_SYSTEM_PROMPT = "1"
    const app = createTestApp()
    const sessionId = "relocate-context-change"
    await post(app, {
      system: "Instructions A",
      messages: [{ role: "user", content: "first" }],
    }, sessionId)

    queryCalls = []
    await post(app, {
      system: "Instructions B",
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "second" },
      ],
    }, sessionId)

    expect(queryCalls[0]!.options.resume).toBeUndefined()
    expect(queryCalls[0]!.prompt).toStartWith("<agent-instructions>\nInstructions B")
  })

  it("rotates back to system-slot behavior when relocation is disabled", async () => {
    process.env.MERIDIAN_RELOCATE_SYSTEM_PROMPT = "1"
    const app = createTestApp()
    const sessionId = "relocate-reverse-toggle"
    const system = "OpenClaw reverse instructions"
    await post(app, {
      system,
      messages: [{ role: "user", content: "first" }],
    }, sessionId)

    delete process.env.MERIDIAN_RELOCATE_SYSTEM_PROMPT
    queryCalls = []
    await post(app, {
      system,
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "second" },
      ],
    }, sessionId)

    expect(queryCalls[0]!.options.resume).toBeUndefined()
    expect(queryCalls[0]!.prompt).not.toContain("<agent-instructions>")
    expect(JSON.stringify(queryCalls[0]!.options.systemPrompt)).toContain("the agent runtime reverse instructions")
  })

  it("uses relocated context in the fresh prompt after a stale undo retry", async () => {
    process.env.MERIDIAN_RELOCATE_SYSTEM_PROMPT = "1"
    throwStaleOnce = true
    const sessionId = "relocate-stale-retry"
    const system = "Retry instructions"
    const prior = [
      { role: "user", content: "first" },
      { role: "assistant", content: "answer" },
      { role: "user", content: "old request" },
      { role: "assistant", content: "old result" },
    ]
    storeSession(
      sessionId,
      prior,
      "sdk-stale",
      undefined,
      [null, "uuid-answer", null, "uuid-result"],
      undefined,
      relocatedHash(system),
    )

    const app = createTestApp()
    await post(app, {
      system,
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "answer" },
        { role: "user", content: "replacement request" },
      ],
    }, sessionId)

    expect(queryCalls).toHaveLength(2)
    expect(queryCalls[0]!.options.resumeSessionAt).toBe("uuid-answer")
    expect(String(queryCalls[0]!.prompt)).not.toContain("<agent-instructions>")
    expect(queryCalls[1]!.options.resume).toBeUndefined()
    expect(queryCalls[1]!.prompt).toStartWith("<agent-instructions>\nRetry instructions")
    expect(JSON.stringify(queryCalls[1]!.options.systemPrompt)).not.toContain("Retry instructions")
  })
})
