/**
 * M1: outbound `<system-reminder>` strip — both the non-streaming whole-string
 * helper and the streaming stateful stripper (cross-delta safety).
 */

import { describe, it, expect } from "bun:test"
import {
  stripSystemReminderBlocks,
  SystemReminderStreamStripper,
} from "../proxy/sanitize"

/** Feed a list of deltas through the stripper and return the full emitted text. */
function runStream(deltas: string[]): string {
  const s = new SystemReminderStreamStripper()
  let out = ""
  for (const d of deltas) out += s.push(d)
  out += s.flush()
  return out
}

describe("stripSystemReminderBlocks (non-streaming)", () => {
  it("removes a complete reminder block, preserving surrounding text", () => {
    const input =
      "before <system-reminder>secret cwd /home/x</system-reminder> after"
    expect(stripSystemReminderBlocks(input)).toBe("before  after")
  })

  it("removes multiple blocks", () => {
    const input =
      "a<system-reminder>one</system-reminder>b<system-reminder>two</system-reminder>c"
    expect(stripSystemReminderBlocks(input)).toBe("abc")
  })

  it("removes a self-closing reminder", () => {
    expect(stripSystemReminderBlocks("x<system-reminder foo='1'/>y")).toBe("xy")
  })

  it("leaves normal text untouched", () => {
    const input = "Just a normal answer with no tags."
    expect(stripSystemReminderBlocks(input)).toBe(input)
  })

  it("does not strip a mere mention of the word", () => {
    const input = "I added a system-reminder feature to the UI."
    expect(stripSystemReminderBlocks(input)).toBe(input)
  })

  // M3: non-stream must match the streaming flush — drop unterminated openers.

  it("drops an unterminated <system-reminder>...CWD block that runs to EOF", () => {
    const input = "keep this <system-reminder>\nCurrent working directory: /home/secret"
    const out = stripSystemReminderBlocks(input)
    expect(out).toBe("keep this ")
    expect(out).not.toContain("/home/secret")
    expect(out).not.toContain("system-reminder")
  })

  it("drops a half-written opener whose '>' never arrived (<system-reminder attr)", () => {
    const input = 'answer text <system-reminder id="sr-1"'
    const out = stripSystemReminderBlocks(input)
    expect(out).toBe("answer text ")
    expect(out).not.toContain("system-reminder")
  })

  it("matches the streaming stripper's EOF behavior for an unterminated block", () => {
    const input = "preamble <system-reminder>leak that never closes"
    const nonStream = stripSystemReminderBlocks(input)
    const streamed = runStream([input])
    expect(nonStream).toBe(streamed)
    expect(nonStream).toBe("preamble ")
  })

  it("does not over-strip a mere prefix-like mention without the full opener", () => {
    // `<system-rem` alone (not the full `<system-reminder` literal) is real prose.
    const input = "discuss <system-rem in a sentence"
    expect(stripSystemReminderBlocks(input)).toBe(input)
  })
})

describe("SystemReminderStreamStripper", () => {
  it("strips a reminder delivered as a single delta", () => {
    expect(runStream(["hi <system-reminder>leak</system-reminder> bye"])).toBe(
      "hi  bye",
    )
  })

  it("strips a reminder split across many tiny deltas", () => {
    const full = "ok <system-reminder>CWD /home/user/secret</system-reminder> done"
    const deltas = full.split("") // one char per delta — worst case
    expect(runStream(deltas)).toBe("ok  done")
  })

  it("holds back a half-written open tag and never leaks it", () => {
    // Tag is split right in the middle of the opener.
    const out = runStream(["answer <system-rem", "inder>leak</system-reminder>!"])
    expect(out).toBe("answer !")
    expect(out).not.toContain("system-rem")
  })

  it("splits the closing tag across deltas", () => {
    const out = runStream(["x<system-reminder>secret</system-rem", "inder>y"])
    expect(out).toBe("xy")
    expect(out).not.toContain("secret")
  })

  it("drops an unterminated reminder block at flush (no close before EOF)", () => {
    // Open tag, content, but stream ends before the close arrives.
    const out = runStream(["keep <system-reminder>partial leak that never closes"])
    expect(out).toBe("keep ")
    expect(out).not.toContain("partial leak")
  })

  it("flush drops a stream that ends on a strict partial opener (<system-rem)", () => {
    // EOF lands mid-opener: `<system-rem`. flush() must not emit the half tag.
    const out = runStream(["here is the answer <system-rem"])
    expect(out).toBe("here is the answer ")
    expect(out).not.toContain("system-rem")
  })

  it("flush drops a stream that ends on a started-but-unterminated opener (<system-reminder attr)", () => {
    // The full `<system-reminder` literal arrived but its `>` never did.
    const out = runStream(["done ", '<system-reminder id="x"'])
    expect(out).toBe("done ")
    expect(out).not.toContain("system-reminder")
  })

  it("emits a trailing partial-open that turns out to be real content", () => {
    // Ends on '<' which could have been an opener — flush must emit it.
    const out = runStream(["price is 5 < 10"])
    expect(out).toBe("price is 5 < 10")
  })

  it("emits a held-back partial opener that does not become a real tag", () => {
    const out = runStream(["see <system-rel", "ated note"])
    expect(out).toBe("see <system-related note")
  })

  it("does not delay normal long text (no false hold-back)", () => {
    const s = new SystemReminderStreamStripper()
    const emitted = s.push("This is a perfectly normal sentence with no tags.")
    expect(emitted).toBe("This is a perfectly normal sentence with no tags.")
    expect(s.flush()).toBe("")
  })

  it("handles two reminders in one stream", () => {
    const out = runStream([
      "a<system-reminder>1</system-reminder>",
      "b<system-reminder>2</system-reminder>c",
    ])
    expect(out).toBe("abc")
  })

  it("strips a self-closing reminder mid-stream", () => {
    expect(runStream(["p<system-reminder x='1'", "/>q"])).toBe("pq")
  })
})
