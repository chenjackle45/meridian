import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

const getCwd = () => process.env.MERIDIAN_WORKDIR ?? process.env.CLAUDE_PROXY_WORKDIR ?? process.cwd()

/**
 * The MCP grep tool handler (registered in mcpTools.ts; lives here so it can
 * be unit-tested directly). Uses execFile (no shell) so pattern/include/path
 * can never be interpreted as shell syntax. From #543 by @sittitep.
 */
export async function runGrepTool(args: { pattern: string; path?: string; include?: string }) {
  try {
    const searchPath = args.path || getCwd()
    const includePattern = args.include || "*"
    const grepArgs = ["-rn", `--include=${includePattern}`, args.pattern, searchPath]
    const { stdout } = await execFileAsync("grep", grepArgs, { maxBuffer: 10 * 1024 * 1024 })
    return {
      content: [{ type: "text" as const, text: stdout || "(no matches)" }]
    }
  } catch (error: unknown) {
    // grep exits with code 1 when no matches are found — not a real error
    const grepError = error as { code?: number; stdout?: string }
    if (grepError.code === 1) {
      return { content: [{ type: "text" as const, text: grepError.stdout || "(no matches)" }] }
    }
    return {
      content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true
    }
  }
}
