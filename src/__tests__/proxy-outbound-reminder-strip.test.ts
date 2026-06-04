/**
 * M1 (e2e): a <system-reminder> in the model's OUTPUT must be stripped from the
 * SSE the client receives — across delta boundaries — and from the non-stream
 * response body. Defense-in-depth so a reminder can never leak to the end user.
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
  parseSSE,
} from "./helpers"

let mockMessages: any[] = []

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: () =>
    (async function* () {
      for (const msg of mockMessages) yield msg
    })(),
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

async function readStreamFull(response: Response): Promise<string> {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let result = ""
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    result += decoder.decode(value, { stream: true })
  }
  return result
}

/** Concatenate all forwarded text_delta payloads in an SSE response. */
function forwardedText(sse: string): string {
  return parseSSE(sse)
    .filter((e) => e.event === "content_block_delta" && (e.data as any).delta?.type === "text_delta")
    .map((e) => (e.data as any).delta.text)
    .join("")
}

describe("M1: outbound <system-reminder> strip (streaming)", () => {
  beforeEach(() => {
    clearSessionCache()
  })

  it("strips a reminder split across multiple text deltas", async () => {
    mockMessages = [
      messageStart(),
      textBlockStart(0),
      textDelta(0, "Here is the answer. "),
      textDelta(0, "<system-reminder>"),
      textDelta(0, "CWD /home/user/.openclaw leaked"),
      textDelta(0, "</system-reminder>"),
      textDelta(0, " Done."),
      blockStop(0),
      messageDelta("end_turn"),
      messageStop(),
    ]

    const app = createTestApp()
    const r = await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    })
    const sse = await readStreamFull(r)
    const text = forwardedText(sse)

    expect(text).toContain("Here is the answer.")
    expect(text).toContain("Done.")
    expect(text).not.toContain("system-reminder")
    expect(text).not.toContain("/home/user/.openclaw")
    expect(text).not.toContain("leaked")
  })

  it("strips a reminder whose opening tag is split mid-tag across deltas", async () => {
    mockMessages = [
      messageStart(),
      textBlockStart(0),
      textDelta(0, "answer <system-rem"),
      textDelta(0, "inder>secret</system-reminder> tail"),
      blockStop(0),
      messageDelta("end_turn"),
      messageStop(),
    ]

    const app = createTestApp()
    const r = await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    })
    const text = forwardedText(await readStreamFull(r))

    expect(text).toContain("answer")
    expect(text).toContain("tail")
    expect(text).not.toContain("system-rem")
    expect(text).not.toContain("secret")
  })

  it("drops an unterminated reminder at end of stream", async () => {
    mockMessages = [
      messageStart(),
      textBlockStart(0),
      textDelta(0, "keep this <system-reminder>never closes before stop end"),
      blockStop(0),
      messageDelta("end_turn"),
      messageStop(),
    ]

    const app = createTestApp()
    const r = await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    })
    const text = forwardedText(await readStreamFull(r))

    expect(text).toContain("keep this")
    expect(text).not.toContain("never closes")
    expect(text).not.toContain("system-reminder")
  })

  it("does not alter a normal streamed answer", async () => {
    mockMessages = [
      messageStart(),
      textBlockStart(0),
      textDelta(0, "The auth flow uses dual tokens: "),
      textDelta(0, "an access token in memory and a refresh cookie."),
      blockStop(0),
      messageDelta("end_turn"),
      messageStop(),
    ]

    const app = createTestApp()
    const r = await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: true,
      messages: [{ role: "user", content: "explain auth" }],
    })
    const text = forwardedText(await readStreamFull(r))

    expect(text).toBe(
      "The auth flow uses dual tokens: an access token in memory and a refresh cookie.",
    )
  })
})

describe("M1: outbound <system-reminder> strip (non-streaming)", () => {
  beforeEach(() => {
    clearSessionCache()
  })

  it("strips a reminder block from the non-stream response body", async () => {
    mockMessages = [
      assistantMessage([
        {
          type: "text",
          text: "Answer. <system-reminder>CWD /home/user/.openclaw secret</system-reminder> End.",
        },
      ]),
    ]

    const app = createTestApp()
    const r = await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [{ role: "user", content: "hi" }],
    })
    const json: any = await r.json()
    const text = (json.content || [])
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("")

    expect(text).toContain("Answer.")
    expect(text).toContain("End.")
    expect(text).not.toContain("system-reminder")
    expect(text).not.toContain("/home/user/.openclaw")
    expect(text).not.toContain("secret")
  })
})
