/**
 * Per-block content sanitizer for orchestration wrapper leakage.
 *
 * Agent harnesses (OpenCode, Droid, ForgeCode, oh-my-opencode, etc.) inject
 * internal markup into message content — `<system-reminder>`, `<env>`,
 * `<task_metadata>`, and similar tags. When the proxy flattens messages into
 * a text prompt for the Agent SDK, these tags become model-visible text that
 * can confuse the model or cause it to echo them back ("talking to itself").
 *
 * This module strips known orchestration tags from **individual text blocks**
 * before flattening — not from the final concatenated string. Operating
 * per-block eliminates the cross-message regex risk that makes full-string
 * sanitization fragile.
 *
 * Pure module — no I/O, no imports from server.ts or session/.
 *
 * Fixes: https://github.com/rynfar/meridian/issues/167
 */

// ---------------------------------------------------------------------------
// Exact tag names known to be orchestration-only.
// These are NOT prefix patterns — each entry is a specific tag name that
// harnesses inject and that never appears in legitimate user content.
// ---------------------------------------------------------------------------

// Tags stripped unconditionally (every adapter).
// `system-reminder` is NOT here — it is overloaded: Droid uses it to leak CWD
// (should strip), but OpenCode's oh-my-opencode harness uses it to surface
// background-task IDs and other orchestration state the model MUST see. So it
// is only stripped when the caller opts in via { stripSystemReminder: true }.
const ORCHESTRATION_TAGS = [
  // OpenCode / Crush: environment context blocks
  "env",
  // ForgeCode: system info wrapper and children
  "system_information",
  "current_working_directory",
  "operating_system",
  "default_shell",
  "home_directory",
  // OpenCode: task/tool/skill orchestration
  "task_metadata",
  "tool_exec",
  "tool_output",
  "skill_content",
  "skill_files",
  // OpenCode: context injection blocks
  "directories",
  "available_skills",
  // Leaked thinking tags (NOT the structured content block type —
  // these are raw XML tags that appear in text content on replay)
  "thinking",
]

// Build regex for paired tags: <tagname ...>...</tagname>
// Each tag gets its own regex to avoid cross-tag matching.
const PAIRED_TAG_PATTERNS: RegExp[] = ORCHESTRATION_TAGS.map(
  (tag) => new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi")
)

// Self-closing variants: <tagname ... />
const SELF_CLOSING_TAG_PATTERNS: RegExp[] = ORCHESTRATION_TAGS.map(
  (tag) => new RegExp(`<${tag}\\b[^>]*\\/>`, "gi")
)

// Non-XML orchestration markers (unique, branded — zero false-positive risk)
const NON_XML_PATTERNS: RegExp[] = [
  // oh-my-opencode internal markers
  /<!--\s*OMO_INTERNAL_INITIATOR\s*-->/gi,
  /\[SYSTEM DIRECTIVE: OH-MY-OPENCODE[^\]]*\]/gi,
  // Background task markers
  /⚙\s*background_output\s*\[task_id=[^\]]*\]\n?/g,
  // Meridian's own file change summary leaking back into conversation
  /\n?---\nFiles changed:[^\n]*(?:\n(?:  [-•*] [^\n]*))*\n?/g,
]

const ALL_PATTERNS = [
  ...PAIRED_TAG_PATTERNS,
  ...SELF_CLOSING_TAG_PATTERNS,
  ...NON_XML_PATTERNS,
]

// Opt-in: only used when the adapter reports that it leaks CWD/env through
// `<system-reminder>` blocks (Droid). Other adapters must preserve these
// blocks — they carry model-visible harness state (see ORCHESTRATION_TAGS).
const SYSTEM_REMINDER_PATTERNS: RegExp[] = [
  /<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder>/gi,
  /<system-reminder\b[^>]*\/>/gi,
]

// Unterminated opener to end-of-string. Applied AFTER the paired/self-closing
// patterns above strip complete blocks — so any `<system-reminder` that still
// remains has no matching close. This catches the non-streaming analogue of the
// streaming flush's drop-on-EOF: an opener whose `>`/`/>` never arrived
// (`<system-reminder attr`) or a `<system-reminder>CWD…` block that runs to EOF
// with no `</system-reminder>`. The negative lookahead mirrors findStartedOpener
// so `<system-reminderX` is not treated as our tag (boundary parity with the
// streaming path).
const SYSTEM_REMINDER_UNTERMINATED: RegExp =
  /<system-reminder(?![A-Za-z0-9_-])[\s\S]*$/i

export interface SanitizeOptions {
  /** Strip `<system-reminder>` blocks. Enable for adapters (Droid) that leak
   *  CWD/env through this tag. */
  stripSystemReminder?: boolean
}

/**
 * Strip orchestration wrappers from a single text string.
 *
 * Designed to be called on individual content blocks (not concatenated
 * prompt strings) to eliminate cross-block regex matching risk.
 */
export function sanitizeTextContent(text: string, opts: SanitizeOptions = {}): string {
  let result = text
  const patterns = opts.stripSystemReminder
    ? [...ALL_PATTERNS, ...SYSTEM_REMINDER_PATTERNS]
    : ALL_PATTERNS
  for (const pattern of patterns) {
    // Reset lastIndex for stateful regexes (those with 'g' flag)
    pattern.lastIndex = 0
    result = result.replace(pattern, "")
  }
  // Collapse runs of 3+ newlines into 2 (avoids large gaps where tags were)
  result = result.replace(/\n{3,}/g, "\n\n")
  return result.trim()
}

// ---------------------------------------------------------------------------
// OUTBOUND strip — remove `<system-reminder>…</system-reminder>` from model
// output before it reaches the client.
//
// The inbound sanitizer (above) cleans the prompt we send to the SDK. This is
// the reverse direction: a defense-in-depth strip on the SDK's response so a
// reminder block can never leak back to the end user — whether the model
// echoed one, or one slipped past the inbound strip. Applied unconditionally
// (NoWayLM's leakage治本); other tags are left untouched.
// ---------------------------------------------------------------------------

// Longest open-tag prefix we might need to hold back across a streamed delta
// boundary so a half-written `<system-reminder` opener never leaks. Closing
// tags are shorter, so this bound covers both.
const SYSTEM_REMINDER_OPEN = "<system-reminder"
const SYSTEM_REMINDER_MAX_PARTIAL = SYSTEM_REMINDER_OPEN.length

/**
 * Strip complete `<system-reminder>…</system-reminder>` blocks (and the
 * self-closing variant) from a fully-assembled string. Use on the
 * non-streaming response path. Does not trim or collapse surrounding text —
 * only the tag spans are removed so the rest of the assistant message is
 * preserved verbatim.
 */
export function stripSystemReminderBlocks(text: string): string {
  let result = text
  for (const pattern of SYSTEM_REMINDER_PATTERNS) {
    pattern.lastIndex = 0
    result = result.replace(pattern, "")
  }
  // After complete blocks are gone, drop any unterminated opener that runs to
  // EOF so this whole-string path matches the streaming stripper's flush()
  // behavior (a half-leaked reminder is worse than a truncated message).
  SYSTEM_REMINDER_UNTERMINATED.lastIndex = 0
  result = result.replace(SYSTEM_REMINDER_UNTERMINATED, "")
  return result
}

/**
 * Stateful, streaming-safe stripper for `<system-reminder>` blocks.
 *
 * Feed it text deltas in order via `push()`; it returns the text that is safe
 * to forward right now (with any reminder spans removed) and internally
 * buffers:
 *  - text inside an open (not-yet-closed) reminder block — dropped on close,
 *  - a short tail that could be the start of a `<system-reminder` opener —
 *    held back until the next delta disambiguates it.
 *
 * Call `flush()` at the end of the block/message to emit any held-back tail.
 * On flush, an unterminated reminder block (open tag with no close before EOF)
 * is dropped entirely — a half-leaked reminder is worse than a truncated one.
 *
 * One instance per content-block index (reminders never span blocks).
 */
export class SystemReminderStreamStripper {
  // Pending text not yet emitted. Either a possible partial open tag (when
  // not inside a block) or accumulated content (when inside a block).
  private buffer = ""
  // True while between a `<system-reminder…>` open and its `</system-reminder>`.
  private inside = false

  /** Feed one delta; returns the text safe to forward now. */
  push(delta: string): string {
    this.buffer += delta
    let out = ""

    // Loop because a single delta may contain multiple open/close transitions.
    // Guard against infinite loops: every branch either returns or shrinks the
    // problem (consumes part of the buffer / sets a hold-back tail).
    for (;;) {
      if (this.inside) {
        const closeIdx = this.buffer.indexOf("</system-reminder>")
        if (closeIdx === -1) {
          // Still inside the block. Drop everything except a possible partial
          // closing tag at the tail so we can detect the close next delta.
          this.buffer = keepPartialSuffix(this.buffer, "</system-reminder>")
          return out
        }
        // Found the close — drop the block content and the close tag, continue
        // scanning the remainder (which is now outside a block).
        this.buffer = this.buffer.slice(closeIdx + "</system-reminder>".length)
        this.inside = false
        continue
      }

      // Outside a block: look for an opener. Self-closing first (rare).
      const selfClose = this.buffer.match(/<system-reminder\b[^>]*\/>/i)
      const open = this.buffer.match(/<system-reminder\b[^>]*>/i)

      // Use whichever real tag appears earliest, if any.
      const candidates = [selfClose, open].filter(
        (m): m is RegExpMatchArray => m !== null && m.index !== undefined,
      )
      if (candidates.length > 0) {
        const earliest = candidates.reduce((a, b) =>
          (a.index! <= b.index! ? a : b),
        )
        const idx = earliest.index!
        // Emit everything before the tag.
        out += this.buffer.slice(0, idx)
        if (earliest === selfClose) {
          // Self-closing: drop the tag, keep scanning after it.
          this.buffer = this.buffer.slice(idx + earliest[0].length)
          continue
        }
        // Paired open: enter the block, drop the open tag, keep scanning.
        this.buffer = this.buffer.slice(idx + earliest[0].length)
        this.inside = true
        continue
      }

      // No complete opener yet. Two hold-back cases:
      //  1. A full `<system-reminder` literal is present but its `>`/`/>` has
      //     not arrived (attributes still streaming) — hold from that `<`.
      //  2. The tail is a strict prefix of `<system-reminder` (e.g. ends on
      //     `<system-rem`) — hold that partial so a half tag never leaks.
      const startedIdx = findStartedOpener(this.buffer)
      const holdLen =
        startedIdx >= 0
          ? this.buffer.length - startedIdx
          : partialOpenLength(this.buffer)
      const safeLen = this.buffer.length - holdLen
      out += this.buffer.slice(0, safeLen)
      this.buffer = this.buffer.slice(safeLen)
      return out
    }
  }

  /** Emit any text still safe to forward at end of stream. */
  flush(): string {
    if (this.inside) {
      // Unterminated reminder block — drop it entirely rather than leak.
      this.buffer = ""
      this.inside = false
      return ""
    }
    // Outside a block: the held-back tail may be a half-written opener that
    // never finished arriving. Only a *complete* `<system-reminder` literal
    // (findStartedOpener — full tag name, possibly mid-attributes) is dropped:
    // that is the high-confidence half-leak case. A mere strict prefix of the
    // opener (`<`, `<sys`, `<system-rem`) at EOF is far more likely legitimate
    // literal output than a reminder — emit it as-is to preserve legal endings
    // and keep stream/non-stream parity (codex r3: dropping prefixes silently
    // truncated `literal <` while non-stream kept it).
    const startedIdx = findStartedOpener(this.buffer)
    const safeLen = startedIdx >= 0 ? startedIdx : this.buffer.length
    const out = this.buffer.slice(0, safeLen)
    this.buffer = ""
    return out
  }
}

/**
 * Length of the suffix of `text` that is a strict, non-empty prefix of the
 * `<system-reminder` opener (and therefore must be held back so a half tag
 * never leaks). Returns 0 when no such partial exists.
 */
/**
 * Index of a `<system-reminder` literal whose `>` / `/>` terminator has not yet
 * appeared (the opener is still streaming its attributes). Returns -1 when no
 * such in-progress opener exists. The whole tail from this index must be held
 * back so a not-yet-complete reminder tag never leaks.
 */
function findStartedOpener(text: string): number {
  const lower = text.toLowerCase()
  const idx = lower.lastIndexOf(SYSTEM_REMINDER_OPEN)
  if (idx === -1) return -1
  // If the opener already terminated (`>` or `/>`) it would have been matched
  // as a complete tag earlier — but the boundary char after the literal must
  // not yet form a terminator. Look for the first `>` after the literal.
  const afterLiteral = text.slice(idx + SYSTEM_REMINDER_OPEN.length)
  // A word-boundary guard: `<system-reminderX` is not our tag.
  if (afterLiteral.length > 0 && /[A-Za-z0-9_-]/.test(afterLiteral[0]!)) return -1
  if (afterLiteral.includes(">")) return -1 // already complete — handled above
  return idx
}

function partialOpenLength(text: string): number {
  const max = Math.min(SYSTEM_REMINDER_MAX_PARTIAL, text.length)
  for (let len = max; len > 0; len--) {
    const suffix = text.slice(text.length - len)
    if (SYSTEM_REMINDER_OPEN.slice(0, len).toLowerCase() === suffix.toLowerCase()) {
      return len
    }
  }
  return 0
}

/**
 * Keep `text` reduced to only a possible partial-suffix of `marker` at its end
 * (used while inside a block to retain a half-written closing tag). Everything
 * that cannot be the start of `marker` is content inside the block and is
 * dropped.
 */
function keepPartialSuffix(text: string, marker: string): string {
  const max = Math.min(marker.length - 1, text.length)
  for (let len = max; len > 0; len--) {
    const suffix = text.slice(text.length - len)
    if (marker.slice(0, len).toLowerCase() === suffix.toLowerCase()) {
      return suffix
    }
  }
  return ""
}
