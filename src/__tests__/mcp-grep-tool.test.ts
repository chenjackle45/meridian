/**
 * Tests for the opencode MCP grep tool handler (src/grepTool.ts).
 *
 * The grep tool must not pass user-controlled input through a shell:
 * interpolating `pattern`/`include`/`path` into an `exec()` string lets a
 * crafted tool call run arbitrary commands. It must also treat grep's
 * exit code 1 (no matches) as a normal empty result, not an error.
 * From #543 by @sittitep.
 */
import { describe, it, expect } from "bun:test"
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runGrepTool } from "../grepTool"

describe("mcpTools grep tool", () => {
  it("finds matches in a directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "grep-test-"))
    try {
      writeFileSync(join(dir, "a.txt"), "hello needle world\n")
      const result = await runGrepTool({ pattern: "needle", path: dir })
      expect(result.isError).toBeUndefined()
      expect(result.content[0]!.text).toContain("needle")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("returns (no matches) for grep exit code 1, not an error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "grep-test-"))
    try {
      writeFileSync(join(dir, "a.txt"), "nothing here\n")
      const result = await runGrepTool({ pattern: "zzz_not_present_zzz", path: dir })
      expect(result.isError).toBeUndefined()
      expect(result.content[0]!.text).toBe("(no matches)")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("does not execute shell metacharacters in the pattern", async () => {
    const dir = mkdtempSync(join(tmpdir(), "grep-test-"))
    const pwned = join(dir, "pwned")
    try {
      writeFileSync(join(dir, "a.txt"), "innocent content\n")
      await runGrepTool({ pattern: `x"; touch "${pwned}"; echo "`, path: dir })
      expect(existsSync(pwned)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("does not execute shell metacharacters in the include pattern", async () => {
    const dir = mkdtempSync(join(tmpdir(), "grep-test-"))
    const pwned = join(dir, "pwned2")
    try {
      writeFileSync(join(dir, "a.txt"), "innocent content\n")
      await runGrepTool({ pattern: "innocent", path: dir, include: `*" --include="*"; touch "${pwned}"; echo "` })
      expect(existsSync(pwned)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
