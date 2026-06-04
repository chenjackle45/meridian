/**
 * M2: the NoWayLM (pi adapter) path must STRIP `<system-reminder>` blocks from
 * inbound history before flattening to a text prompt.
 *
 * NoWayLM's OpenClaw runtime injects `<system-reminder>` blocks carrying the
 * host CWD / orchestration context. On replay these would echo back into the
 * flattened prompt and pollute the model's view (and leak the host path). The
 * pi transform opts into the same inbound strip Droid uses
 * (leaksCwdViaSystemReminder → sanitizeOpts.stripSystemReminder).
 *
 * This is the INBOUND direction only (client → SDK prompt). OpenCode must keep
 * preserving system-reminder (covered by proxy-system-reminder-preservation),
 * so the strip is scoped to the pi adapter, not global.
 */

import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test"
import { assistantMessage } from "./helpers"

let mockMessages: any[] = []
let capturedQueryParams: any = null

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (params: any) => {
    capturedQueryParams = params
    return (async function* () {
      for (const msg of mockMessages) yield msg
    })()
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
  tool: () => ({}),
}))

mock.module("../logger", () => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: any, fn: any) => fn(),
}))

const { createProxyServer, clearSessionCache } = await import("../proxy/server")

function createTestApp() {
  const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
  return app
}

async function post(app: any, body: any, headers: Record<string, string> = {}) {
  return app.fetch(
    new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  )
}

function promptText(): string {
  const p = capturedQueryParams?.prompt
  if (typeof p === "string") return p
  return String(p)
}

// pi adapter forced via x-meridian-agent header; passthrough off for a plain
// text-prompt path so we can assert on the flattened string.
const PI = { "x-meridian-agent": "pi" }

const HOST_LEAK_REMINDER = `<system-reminder>
Current working directory: /home/user/.openclaw/workspace
The user opened files: secret-plan.md
</system-reminder>
What is in the repo?`

describe("M2: pi adapter strips inbound <system-reminder>", () => {
  let savedPassthrough: string | undefined
  let savedDefaultAgent: string | undefined

  beforeEach(() => {
    mockMessages = [assistantMessage([{ type: "text", text: "ok" }])]
    capturedQueryParams = null
    clearSessionCache()
    savedPassthrough = process.env.MERIDIAN_PASSTHROUGH
    savedDefaultAgent = process.env.MERIDIAN_DEFAULT_AGENT
    process.env.MERIDIAN_PASSTHROUGH = "0"
    delete process.env.MERIDIAN_DEFAULT_AGENT
  })

  afterEach(() => {
    if (savedPassthrough !== undefined) process.env.MERIDIAN_PASSTHROUGH = savedPassthrough
    else delete process.env.MERIDIAN_PASSTHROUGH
    if (savedDefaultAgent !== undefined) process.env.MERIDIAN_DEFAULT_AGENT = savedDefaultAgent
    else delete process.env.MERIDIAN_DEFAULT_AGENT
  })

  it("strips the system-reminder block and the leaked host CWD from the prompt", async () => {
    const app = createTestApp()
    await (await post(app, {
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 1024,
      stream: false,
      messages: [{ role: "user", content: HOST_LEAK_REMINDER }],
    }, PI)).json()

    const prompt = promptText()
    expect(prompt).not.toContain("system-reminder")
    expect(prompt).not.toContain("/home/user/.openclaw/workspace")
    expect(prompt).not.toContain("secret-plan.md")
    // The real user question survives.
    expect(prompt).toContain("What is in the repo?")
  })

  it("strips system-reminder when content is an array of text blocks", async () => {
    const app = createTestApp()
    await (await post(app, {
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 1024,
      stream: false,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: `<system-reminder>\nCWD: /tmp/host\n</system-reminder>` },
            { type: "text", text: "explain the auth flow" },
          ],
        },
      ],
    }, PI)).json()

    const prompt = promptText()
    expect(prompt).not.toContain("/tmp/host")
    expect(prompt).not.toContain("system-reminder")
    expect(prompt).toContain("explain the auth flow")
  })

  it("does not over-strip: legitimate prose that merely mentions the word survives", async () => {
    const app = createTestApp()
    // No actual <system-reminder> tag — just substantive text discussing it.
    // The strip is tag-scoped, so the surrounding content must be untouched.
    await (await post(app, {
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 1024,
      stream: false,
      messages: [
        {
          role: "user",
          content: "How should I handle a system reminder feature in my UI? Keep the design simple.",
        },
      ],
    }, PI)).json()

    const prompt = promptText()
    expect(prompt).toContain("How should I handle a system reminder feature")
    expect(prompt).toContain("Keep the design simple.")
  })
})
