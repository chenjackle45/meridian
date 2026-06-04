/**
 * End-to-end guard: a resume must never drop the current turn's user message.
 *
 * NoWayLM's OpenClaw runtime calls Meridian (pi adapter, passthrough) sending
 * the FULL messages[] every turn — history first, the current user message last.
 * On a resume the proxy only forwards a delta of "new" messages the SDK doesn't
 * already have (see selectResumeDelta). The deterministic drop / sentinel
 * behavior is unit-tested in messages.test.ts; these tests assert the invariant
 * through the real server pipeline: whatever prompt the proxy hands to the SDK
 * on a resume MUST contain the current turn's last user message text.
 */

import { describe, it, expect, mock, beforeEach } from "bun:test"
import {
  assistantMessage,
  messageStart,
  textBlockStart,
  textDelta,
  blockStop,
  messageDelta,
  messageStop,
} from "./helpers"

// --- Capture SDK calls ---
let mockMessages: any[] = []
let capturedQueryParams: any = null

const MOCK_SDK_SESSION = "sdk-session-resume-payload"

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (params: any) => {
    capturedQueryParams = params
    return (async function* () {
      for (const msg of mockMessages) {
        yield { ...msg, session_id: MOCK_SDK_SESSION }
      }
    })()
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
  tool: () => ({}),
}))

mock.module("../logger", () => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: any, fn: any) => fn(),
}))

mock.module("../mcpTools", () => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }),
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

/** Flatten whatever the proxy passed to the SDK (text or structured) to a string. */
function promptText(): string {
  const p = capturedQueryParams?.prompt
  if (typeof p === "string") return p
  return String(p)
}

describe("resume delta keeps the current turn's user message (e2e)", () => {
  beforeEach(() => {
    mockMessages = [assistantMessage([{ type: "text", text: "Hello" }])]
    clearSessionCache()
    capturedQueryParams = null
  })

  it("keeps the user message when a trailing scaffold message follows it", async () => {
    const app = createTestApp()

    await (await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [{ role: "user", content: "First question" }],
    }, { "x-opencode-session": "drift-session" })).json()

    mockMessages = [assistantMessage([{ type: "text", text: "Answer" }])]

    await (await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [
        { role: "user", content: "First question" },
        { role: "assistant", content: [{ type: "text", text: "Hello" }] },
        { role: "user", content: "MARKER_CURRENT_USER_TURN" },
        { role: "assistant", content: [{ type: "text", text: "(trailing scaffold)" }] },
      ],
    }, { "x-opencode-session": "drift-session" })).json()

    expect(promptText()).toContain("MARKER_CURRENT_USER_TURN")
  })

  it("keeps the current user message across a chain of resumes", async () => {
    const app = createTestApp()

    await (await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [
        { role: "user", content: "msg 0" },
        { role: "assistant", content: [{ type: "text", text: "a0" }] },
        { role: "user", content: "msg 1" },
        { role: "assistant", content: [{ type: "text", text: "a1" }] },
        { role: "user", content: "msg 2" },
      ],
    }, { "x-opencode-session": "chain-session" })).json()

    mockMessages = [assistantMessage([{ type: "text", text: "ack" }])]

    await (await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [
        { role: "user", content: "msg 0" },
        { role: "assistant", content: [{ type: "text", text: "a0" }] },
        { role: "user", content: "msg 1" },
        { role: "assistant", content: [{ type: "text", text: "a1" }] },
        { role: "user", content: "msg 2" },
        { role: "assistant", content: [{ type: "text", text: "a2" }] },
        { role: "user", content: "LATEST_USER_QUESTION" },
      ],
    }, { "x-opencode-session": "chain-session" })).json()

    expect(promptText()).toContain("LATEST_USER_QUESTION")
  })

  it("keeps the current user message on a streaming resume", async () => {
    const app = createTestApp()

    await (await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [{ role: "user", content: "stream first" }],
    }, { "x-opencode-session": "stream-drift" })).json()

    mockMessages = [
      messageStart(),
      textBlockStart(0),
      textDelta(0, "ok"),
      blockStop(0),
      messageDelta("end_turn"),
      messageStop(),
    ]

    const r2 = await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: true,
      messages: [
        { role: "user", content: "stream first" },
        { role: "assistant", content: [{ type: "text", text: "Hello" }] },
        { role: "user", content: "STREAM_CURRENT_USER" },
        { role: "assistant", content: [{ type: "text", text: "(scaffold)" }] },
      ],
    }, { "x-opencode-session": "stream-drift" })

    const reader = r2.body!.getReader()
    while (true) {
      const { done } = await reader.read()
      if (done) break
    }

    expect(promptText()).toContain("STREAM_CURRENT_USER")
  })
})
