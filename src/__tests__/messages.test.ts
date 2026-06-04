/**
 * Unit tests for message parsing utilities.
 */
import { describe, it, expect } from "bun:test"
import { normalizeContent, getLastUserMessage, selectResumeDelta, extractAdvisorModel, stripAdvisorTools } from "../proxy/messages"

describe("normalizeContent", () => {
  it("returns string content as-is", () => {
    expect(normalizeContent("hello")).toBe("hello")
  })

  it("extracts text from text content blocks", () => {
    const content = [{ type: "text", text: "hello world" }]
    expect(normalizeContent(content)).toBe("hello world")
  })

  it("handles tool_use blocks", () => {
    const content = [{ type: "tool_use", id: "tu_1", name: "Read", input: { file: "a.ts" } }]
    const result = normalizeContent(content)
    expect(result).toContain("tool_use:tu_1:Read:")
    expect(result).toContain('"file":"a.ts"')
  })

  it("handles tool_result blocks with string content", () => {
    const content = [{ type: "tool_result", tool_use_id: "tu_1", content: "file contents" }]
    const result = normalizeContent(content)
    expect(result).toBe("tool_result:tu_1:file contents")
  })

  it("handles tool_result blocks with object content", () => {
    const content = [{ type: "tool_result", tool_use_id: "tu_1", content: { key: "val" } }]
    const result = normalizeContent(content)
    expect(result).toContain("tool_result:tu_1:")
    expect(result).toContain('"key":"val"')
  })

  it("handles mixed content blocks", () => {
    const content = [
      { type: "text", text: "hello" },
      { type: "text", text: "world" },
    ]
    expect(normalizeContent(content)).toBe("hello\nworld")
  })

  it("JSON stringifies unknown block types", () => {
    const content = [{ type: "image", data: "base64" }]
    const result = normalizeContent(content)
    expect(result).toContain('"type":"image"')
  })

  it("produces stable hashes when cache_control is added to text blocks", () => {
    const without = [{ type: "text", text: "hello" }]
    const withCC = [{ type: "text", text: "hello", cache_control: { type: "ephemeral" } }]
    // text blocks extract only .text, so cache_control is already ignored
    expect(normalizeContent(without)).toBe(normalizeContent(withCC))
  })

  it("produces stable hashes when cache_control is added to tool_result content blocks", () => {
    const without = [{ type: "tool_result", tool_use_id: "tu_1", content: [{ type: "text", text: "result" }] }]
    const withCC = [{ type: "tool_result", tool_use_id: "tu_1", content: [{ type: "text", text: "result", cache_control: { type: "ephemeral" } }] }]
    expect(normalizeContent(without)).toBe(normalizeContent(withCC))
  })

  it("produces stable hashes when cache_control is added to unknown block types", () => {
    const without = [{ type: "image", data: "base64" }]
    const withCC = [{ type: "image", data: "base64", cache_control: { type: "ephemeral" } }]
    expect(normalizeContent(without)).toBe(normalizeContent(withCC))
  })

  it("converts non-string non-array to string", () => {
    expect(normalizeContent(42)).toBe("42")
    expect(normalizeContent(null)).toBe("null")
    expect(normalizeContent(true)).toBe("true")
  })
})

describe("getLastUserMessage", () => {
  it("returns the last user message", () => {
    const messages = [
      { role: "user", content: "first" },
      { role: "assistant", content: "reply" },
      { role: "user", content: "second" },
    ]
    const result = getLastUserMessage(messages)
    expect(result).toHaveLength(1)
    expect(result[0]!.content).toBe("second")
  })

  it("returns last message as fallback when no user messages", () => {
    const messages = [
      { role: "assistant", content: "reply" },
    ]
    const result = getLastUserMessage(messages)
    expect(result).toHaveLength(1)
    expect(result[0]!.content).toBe("reply")
  })

  it("handles empty array", () => {
    const result = getLastUserMessage([])
    expect(result).toHaveLength(0)
  })

  it("returns single user message from single-message array", () => {
    const messages = [{ role: "user", content: "only" }]
    const result = getLastUserMessage(messages)
    expect(result).toHaveLength(1)
    expect(result[0]!.content).toBe("only")
  })
})

describe("selectResumeDelta", () => {
  // Helpers to build small conversations.
  const u = (c: string) => ({ role: "user", content: c })
  const a = (c: string) => ({ role: "assistant", content: [{ type: "text", text: c }] })

  it("returns the tail slice for a well-behaved continuation (user is the array tail)", () => {
    const msgs = [u("q0"), a("a0"), u("q1")]
    // Previous turn recorded 2 messages; the new user message is at index 2.
    const delta = selectResumeDelta(msgs, 2)
    expect(delta.map((m) => m.content)).toEqual(["q1"])
  })

  it("includes the current user message even when trailing messages follow it", () => {
    const msgs = [u("q0"), a("a0"), u("q1"), a("scaffold")]
    const delta = selectResumeDelta(msgs, 2)
    // The slice keeps the user message AND the trailing scaffold — but crucially
    // the user's question is present.
    expect(delta.some((m) => m.role === "user" && m.content === "q1")).toBe(true)
  })

  it("SENTINEL: does not drop the current user message when knownCount drifts past it", () => {
    // Reproduction of the production bug: the new user question sits at index 4,
    // but the recorded count drifted to 5 (e.g. a stale count from a prior
    // early-break turn). A naive slice(5) returns [a("a2")] — history only, no
    // user content — and the model answers nothing (NO_REPLY).
    const msgs = [u("q0"), a("a0"), u("q1"), a("a1"), u("q2"), a("a2")]
    const naive = msgs.slice(5)
    expect(naive.some((m) => m.role === "user")).toBe(false) // demonstrates the bug surface

    const delta = selectResumeDelta(msgs, 5)
    // The fix falls back to the last user message so the question always lands.
    expect(delta.some((m) => m.role === "user" && m.content === "q2")).toBe(true)
  })

  it("SENTINEL: drift where the user message is the tail still recovers it", () => {
    const msgs = [u("q0"), a("a0"), u("q1")]
    // knownCount drifted past everything (== length): legacy branch already
    // falls back to last user — assert it stays correct.
    const delta = selectResumeDelta(msgs, 3)
    expect(delta.map((m) => m.content)).toEqual(["q1"])
  })

  it("falls back to last user message when knownCount is 0 (legacy/first store)", () => {
    const msgs = [u("q0"), a("a0"), u("q1")]
    const delta = selectResumeDelta(msgs, 0)
    expect(delta.map((m) => m.content)).toEqual(["q1"])
  })

  it("degenerates gracefully when there is no user message", () => {
    const msgs = [a("a0"), a("a1")]
    const delta = selectResumeDelta(msgs, 1)
    expect(delta).toHaveLength(1)
    expect(delta[0]!.role).toBe("assistant")
  })

  // --- BOUNDARY fix: bound the delta to the last user turn ---

  it("BOUNDARY: drops the prior assistant the SDK already has (does not re-send it)", () => {
    // [user0, assistant0, user1], knownCount=1: a naive slice(1) returns
    // [assistant0, user1], re-sending the SDK's own prior reply. The fix bounds
    // the delta to the last user turn, so only [user1] is forwarded.
    const msgs = [u("q0"), a("a0"), u("q1")]
    const delta = selectResumeDelta(msgs, 1)
    expect(delta.map((m) => m.role)).toEqual(["user"])
    expect(delta.map((m) => m.content)).toEqual(["q1"])
    // The prior assistant text must not be present in the delta.
    expect(delta.some((m) => m.role === "assistant")).toBe(false)
  })

  it("BOUNDARY: truncates trailing non-user scaffold so the delta ends on the user turn", () => {
    // [user0, assistant0, user1, assistant_scaffold], knownCount=1.
    const msgs = [u("q0"), a("a0"), u("q1"), a("trailing scaffold")]
    const delta = selectResumeDelta(msgs, 1)
    expect(delta.map((m) => m.content)).toEqual(["q1"])
    // Ends on the user turn — no trailing assistant scaffold.
    expect(delta[delta.length - 1]!.role).toBe("user")
    expect(delta.some((m) => m.content === "trailing scaffold")).toBe(false)
  })

  it("BOUNDARY: keeps intermediate new user turns, dropping only the leading prior assistant", () => {
    // A multi-turn batch arrives at once: knownCount lands on a leading
    // assistant, but the intermediate user turn is genuinely new and must stay.
    const msgs = [u("q0"), a("a0"), u("q1"), a("a1"), u("q2")]
    // SDK last knew 2 messages (q0, a0). slice(2) = [u1, a1, u2]; first element
    // is a user, so nothing is dropped from the front; ends on u2. (Assistant
    // content is a block array, so compare roles + user-message text.)
    const delta = selectResumeDelta(msgs, 2)
    expect(delta.map((m) => m.role)).toEqual(["user", "assistant", "user"])
    expect(delta.filter((m) => m.role === "user").map((m) => m.content)).toEqual(["q1", "q2"])
    expect(delta[delta.length - 1]!.role).toBe("user")
  })

  it("BOUNDARY: drops a leading prior assistant in a multi-turn batch but keeps the rest", () => {
    const msgs = [u("q0"), a("a0"), u("q1"), a("a1"), u("q2")]
    // knownCount=1 -> slice starts at a0 (assistant). Drop the single leading
    // assistant, keep [u1, a1, u2], end on u2.
    const delta = selectResumeDelta(msgs, 1)
    expect(delta.map((m) => m.role)).toEqual(["user", "assistant", "user"])
    expect(delta.filter((m) => m.role === "user").map((m) => m.content)).toEqual(["q1", "q2"])
    expect(delta[0]!.role).toBe("user")
    expect(delta[delta.length - 1]!.role).toBe("user")
  })
})

describe("extractAdvisorModel", () => {
  it("extracts model from advisor tool definition", () => {
    const tools = [
      { name: "Read", description: "Read a file" },
      { type: "advisor_20260301", name: "advisor", model: "claude-opus-4-7" },
    ]
    expect(extractAdvisorModel(tools)).toBe("claude-opus-4-7")
  })

  it("returns undefined when no advisor tool is present", () => {
    const tools = [{ name: "Read" }, { name: "Write" }]
    expect(extractAdvisorModel(tools)).toBeUndefined()
  })

  it("returns undefined for non-array input", () => {
    expect(extractAdvisorModel(undefined)).toBeUndefined()
    expect(extractAdvisorModel(null)).toBeUndefined()
    expect(extractAdvisorModel("not-array")).toBeUndefined()
  })

  it("returns undefined when model is missing or empty", () => {
    expect(extractAdvisorModel([{ type: "advisor_20260301", name: "advisor" }])).toBeUndefined()
    expect(extractAdvisorModel([{ type: "advisor_20260301", name: "advisor", model: "" }])).toBeUndefined()
  })

  it("matches any advisor_ type prefix", () => {
    expect(extractAdvisorModel([{ type: "advisor_20270101", name: "advisor", model: "claude-opus-5" }])).toBe("claude-opus-5")
  })
})

describe("stripAdvisorTools", () => {
  it("removes advisor tool definitions from array", () => {
    const tools = [
      { name: "Read", description: "Read a file" },
      { type: "advisor_20260301", name: "advisor", model: "claude-opus-4-7" },
      { name: "Write", description: "Write a file" },
    ]
    const result = stripAdvisorTools(tools)
    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({ name: "Read", description: "Read a file" })
    expect(result[1]).toEqual({ name: "Write", description: "Write a file" })
  })

  it("returns all tools when no advisor tool is present", () => {
    const tools = [{ name: "Read" }, { name: "Write" }]
    expect(stripAdvisorTools(tools)).toHaveLength(2)
  })

  it("handles empty array", () => {
    expect(stripAdvisorTools([])).toHaveLength(0)
  })
})
