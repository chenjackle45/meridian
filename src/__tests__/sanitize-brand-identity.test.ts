/**
 * Tests for sanitizeBrandIdentity — the NoWayLM billing-safety brand strip.
 *
 * Rule under test (B partial-replacement): case-sensitive replace of the
 * capitalized brand spelling `OpenClaw` (descriptive / identity prose) with a
 * neutral runtime descriptor, while leaving lowercase `openclaw` (CLI commands,
 * filesystem paths, URLs, skill-frontmatter keys) untouched because those are
 * load-bearing literals the model actually executes / dereferences.
 */
import { describe, it, expect } from "bun:test"
import { sanitizeBrandIdentity } from "../proxy/query"

describe("sanitizeBrandIdentity", () => {
  it("replaces capitalized brand prose with the neutral descriptor", () => {
    expect(sanitizeBrandIdentity("You are a personal assistant running inside OpenClaw.")).toBe(
      "You are a personal assistant running inside the agent runtime.",
    )
  })

  it("replaces every capitalized occurrence (global)", () => {
    const input = "OpenClaw handles routing. OpenClaw also manages sessions."
    expect(sanitizeBrandIdentity(input)).toBe(
      "the agent runtime handles routing. the agent runtime also manages sessions.",
    )
    expect(sanitizeBrandIdentity(input)).not.toContain("OpenClaw")
  })

  it("leaves lowercase CLI commands untouched (load-bearing)", () => {
    const input = "Run `openclaw gateway restart` then `openclaw status`."
    const out = sanitizeBrandIdentity(input)
    expect(out).toContain("openclaw gateway restart")
    expect(out).toContain("openclaw status")
  })

  it("leaves lowercase filesystem paths untouched (load-bearing)", () => {
    const input = "Credentials live only in /home/user/.openclaw/ for isolation."
    expect(sanitizeBrandIdentity(input)).toBe(
      "Credentials live only in /home/user/.openclaw/ for isolation.",
    )
  })

  it("leaves lowercase URLs untouched (load-bearing)", () => {
    const input = "Docs: https://docs.openclaw.ai — Source: https://github.com/openclaw/openclaw"
    expect(sanitizeBrandIdentity(input)).toBe(input)
  })

  it("leaves lowercase skill-frontmatter keys untouched (load-bearing)", () => {
    const input = "Remove metadata.openclaw.requires.bins to enable the skill."
    expect(sanitizeBrandIdentity(input)).toBe(input)
  })

  it("only rewrites the capitalized token when both spellings coexist on one line", () => {
    // "OpenClaw docs: https://docs.openclaw.ai" — heading-style cap brand + URL.
    const input = "OpenClaw docs: https://docs.openclaw.ai"
    const out = sanitizeBrandIdentity(input)
    expect(out).toBe("the agent runtime docs: https://docs.openclaw.ai")
    // The capitalized identity is gone…
    expect(/OpenClaw/.test(out)).toBe(false)
    // …but the URL's lowercase token survives intact.
    expect(out).toContain("docs.openclaw.ai")
  })

  it("rewrites heading-style brand references", () => {
    expect(sanitizeBrandIdentity("## OpenClaw CLI Quick Reference")).toBe(
      "## the agent runtime CLI Quick Reference",
    )
  })

  it("does not touch unrelated case variants (boundary: OPENCLAW / Openclaw stay as-is)", () => {
    // Only the exact `OpenClaw` spelling is descriptive prose in the audited
    // sources. Other casings are not produced by either source; leave them be
    // rather than over-match (conservative: prefer a miss over a false strike).
    const input = "OPENCLAW_DEFAULTS and Openclaw are not the brand-prose spelling."
    expect(sanitizeBrandIdentity(input)).toBe(input)
  })

  it("is a no-op on text with no brand references", () => {
    expect(sanitizeBrandIdentity("Plain context with no brand mentions.")).toBe(
      "Plain context with no brand mentions.",
    )
  })

  it("handles empty string", () => {
    expect(sanitizeBrandIdentity("")).toBe("")
  })
})
