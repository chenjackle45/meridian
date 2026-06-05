/**
 * Message parsing and normalization utilities.
 */

/**
 * Strip cache_control from a content block (or nested blocks).
 * cache_control is ephemeral metadata that agents add/remove between requests;
 * it must not affect content hashing or lineage verification.
 */
function stripCacheControlForHashing(obj: any): any {
  if (!obj || typeof obj !== "object") return obj
  if (Array.isArray(obj)) return obj.map(stripCacheControlForHashing)
  const { cache_control, ...rest } = obj
  return rest
}

/**
 * Normalize message content to a string for hashing and comparison.
 * Handles both string content and array content (Anthropic content blocks).
 * Strips cache_control metadata to ensure hash stability across requests.
 *
 * NOTE: OpenCode sends content as a string on the first request but as
 * an array on subsequent ones. This normalizer handles both formats.
 * Other agents may behave differently — this will move to the adapter pattern.
 */
export function normalizeContent(content: any): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content.map((block: any) => {
      if (block.type === "text" && block.text) return block.text
      if (block.type === "tool_use") return `tool_use:${block.id}:${block.name}:${JSON.stringify(block.input)}`
      if (block.type === "tool_result") {
        const inner = block.content
        if (typeof inner === "string") return `tool_result:${block.tool_use_id}:${inner}`
        // Strip cache_control from nested content blocks before serializing
        return `tool_result:${block.tool_use_id}:${JSON.stringify(stripCacheControlForHashing(inner))}`
      }
      // Unknown block types: strip cache_control before serializing
      return JSON.stringify(stripCacheControlForHashing(block))
    }).join("\n")
  }
  return String(content)
}

/**
 * Extract the advisor model from a tools array.
 * Returns the model string if an advisor tool definition is found, undefined otherwise.
 * The advisor tool is identified by a type starting with "advisor_".
 */
export function extractAdvisorModel(tools: unknown): string | undefined {
  if (!Array.isArray(tools)) return undefined
  for (const tool of tools) {
    if (!tool || typeof tool !== "object") continue
    const candidate = tool as Record<string, unknown>
    if (typeof candidate.type === "string" && candidate.type.startsWith("advisor_") && typeof candidate.model === "string" && candidate.model.length > 0) {
      return candidate.model
    }
  }
  return undefined
}

/**
 * Remove advisor tool definitions from a tools array.
 * Returns a new array with advisor tools filtered out.
 */
export function stripAdvisorTools(tools: unknown[]): unknown[] {
  return tools.filter((tool) => {
    if (!tool || typeof tool !== "object") return true
    const candidate = tool as Record<string, unknown>
    return !(typeof candidate.type === "string" && candidate.type.startsWith("advisor_"))
  })
}

/**
 * Extract only the last user message (for session resume — SDK already has history).
 */
export function getLastUserMessage(messages: Array<{ role: string; content: any }>): Array<{ role: string; content: any }> {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") return [messages[i]!]
  }
  return messages.slice(-1)
}

/**
 * Extract the last contiguous run of user messages (the current user "turn").
 *
 * Unlike getLastUserMessage (single last user message), this returns ALL
 * trailing consecutive user messages. The pi/OpenClaw client emits one logical
 * turn as TWO adjacent user messages — the content message FOLLOWED BY a
 * trailing "Sender (untrusted metadata)" block. getLastUserMessage would return
 * only that trailing metadata block, dropping the user's actual question and
 * leaving the model with metadata-only input (→ empty / NO_REPLY turn).
 * Returning the whole trailing user run keeps the real content in the delta.
 *
 * Trade-off vs #171 (identical-array continuation): when the last turn happens
 * to be multiple user messages the SDK already holds, this re-sends the whole
 * run rather than a single message. Accepted: every real resume here carries a
 * fresh user turn (length > cached count → modified continuation), so the
 * "nothing new" identical-array path does not reach this fallback in the pi
 * adapter; and forwarding a metadata tail is far cheaper than swallowing the
 * user's question.
 */
export function getLastUserTurn(messages: Array<{ role: string; content: any }>): Array<{ role: string; content: any }> {
  const userIdx = lastUserIndex(messages)
  if (userIdx < 0) return messages.slice(-1)
  return messages.slice(lastUserTurnStart(messages, userIdx), userIdx + 1)
}

/**
 * Index of the first message in the last contiguous run of user messages
 * ending at `userIdx`. Walks backward while the prior message is also a user
 * message. Used to keep a double-user turn (content + trailing metadata) whole.
 */
function lastUserTurnStart(messages: Array<{ role: string; content: any }>, userIdx: number): number {
  let start = userIdx
  while (start > 0 && messages[start - 1]?.role === "user") start--
  return start
}

/**
 * Return the index of the last user message, or -1 if none.
 */
function lastUserIndex(messages: Array<{ role: string; content: any }>): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") return i
  }
  return -1
}

/**
 * Pick the slice of messages to forward to the SDK on a session resume.
 *
 * The SDK already holds the conversation history, so we only forward the
 * "new" tail: `allMessages.slice(knownCount)`, where knownCount is the message
 * count recorded on a previous turn.
 *
 * SENTINEL (the fix): the recorded count can drift — a prior turn may have
 * ended on an early break that left a stale count, or the client array can
 * advance by a different amount than the proxy recorded. When that happens a
 * naive slice can land at or past the current turn's user message and drop it
 * entirely. The SDK then receives a delta with NO user content and the model
 * produces an empty / NO_REPLY turn (in production this silently swallowed
 * 31+ user questions).
 *
 * To stay caller-agnostic, this helper never trusts the slice blindly: if the
 * slice would start past the conversation's current last user message, it
 * falls back to forwarding just that last user message. This is byte-identical
 * to today for the well-behaved case (the user turn is at or after knownCount)
 * and only changes behavior when a drop would otherwise occur.
 *
 * BOUNDARY (second fix): the delta is bounded by the *last user turn*, not the
 * raw array tail. Two adjustments to the naive `slice(knownCount)`:
 *  - drop any leading non-user (prior assistant) messages — the SDK already
 *    holds its own prior outputs in session, so re-sending them duplicates
 *    history; and
 *  - truncate any trailing non-user scaffold *after* the last user message, so
 *    the forwarded prompt always ends on the user's question.
 * Re-sending the prior assistant and ending on a scaffold made the prompt end
 * with an assistant turn, which could reproduce the "sees it but doesn't reply"
 * symptom. Bounding to the last user turn keeps the model answering the current
 * question.
 */
export function selectResumeDelta(
  allMessages: Array<{ role: string; content: any }>,
  knownCount: number,
): Array<{ role: string; content: any }> {
  const userIdx = lastUserIndex(allMessages)

  // No user message at all (degenerate) — fall back to the legacy behavior.
  if (userIdx < 0) return getLastUserTurn(allMessages)

  if (knownCount > 0 && knownCount < allMessages.length) {
    // Sentinel: the slice start must sit at or before the current last user
    // message. If knownCount drifted past it, the slice would omit the user's
    // question — fall back to forwarding the last user turn so the model
    // always sees the current turn (content + any trailing metadata).
    if (knownCount <= userIdx) {
      // Drop leading prior-assistant messages the SDK already has (start the
      // delta at the first new user message), and truncate any trailing
      // non-user scaffold after the last user turn (end at userIdx + 1).
      let start = knownCount
      while (start < userIdx && allMessages[start]?.role !== "user") start++
      // If knownCount landed INSIDE the last contiguous user run (e.g. pointing
      // at the trailing "Sender (untrusted metadata)" message of a pi double-user
      // turn), pull start back to the run's first message so the real question
      // is never sliced off. Earlier new user turns (separated by an assistant)
      // are unaffected — turnStart only rewinds within the final user run.
      const turnStart = lastUserTurnStart(allMessages, userIdx)
      if (start > turnStart) start = turnStart
      return allMessages.slice(start, userIdx + 1)
    }
    return getLastUserTurn(allMessages)
  }

  return getLastUserTurn(allMessages)
}
