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
 */
export function selectResumeDelta(
  allMessages: Array<{ role: string; content: any }>,
  knownCount: number,
): Array<{ role: string; content: any }> {
  const userIdx = lastUserIndex(allMessages)

  // No user message at all (degenerate) — fall back to the legacy behavior.
  if (userIdx < 0) return getLastUserMessage(allMessages)

  if (knownCount > 0 && knownCount < allMessages.length) {
    // Sentinel: the slice start must sit at or before the current last user
    // message. If knownCount drifted past it, the slice would omit the user's
    // question — fall back to forwarding just the last user message so the
    // model always sees the current turn.
    if (knownCount <= userIdx) {
      return allMessages.slice(knownCount)
    }
    return getLastUserMessage(allMessages)
  }

  return getLastUserMessage(allMessages)
}
