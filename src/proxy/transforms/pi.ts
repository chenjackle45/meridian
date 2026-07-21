import type { Transform, RequestContext } from "../transform"
import { extractFileChangesFromBash, type FileChange } from "../fileChanges"
import { BLOCKED_BUILTIN_TOOLS, CLAUDE_CODE_ONLY_TOOLS } from "../tools"
import { resolvePassthrough } from "../../env"

const PI_MCP_SERVER_NAME = "pi"
const PI_ALLOWED_MCP_TOOLS: readonly string[] = [
  `mcp__${PI_MCP_SERVER_NAME}__read`,
  `mcp__${PI_MCP_SERVER_NAME}__write`,
  `mcp__${PI_MCP_SERVER_NAME}__edit`,
  `mcp__${PI_MCP_SERVER_NAME}__bash`,
  `mcp__${PI_MCP_SERVER_NAME}__glob`,
  `mcp__${PI_MCP_SERVER_NAME}__grep`,
]

/**
 * Resolve passthrough mode for Pi from env. Mirrors the adapter's
 * `usesPassthrough()` so the transform and adapter agree (transform-parity
 * test enforces this). Default is ON — pi owns its tool execution loop, so
 * tool_use blocks must flow back to pi. In internal mode only the hardcoded
 * MCP tool set is exposed and pi's own tools (web_search/web_fetch/etc.) are
 * dropped. Opt out via `MERIDIAN_PASSTHROUGH=0`.
 */
function resolvePiPassthrough(): boolean {
  return resolvePassthrough(true)
}

export const piTransforms: Transform[] = [
  {
    name: "pi-core",
    adapters: ["pi"],
    onRequest(ctx: RequestContext): RequestContext {
      const extractFileChangesFromToolUse = (toolName: string, toolInput: unknown): FileChange[] => {
        const input = toolInput as Record<string, unknown> | null | undefined
        const filePath = input?.filePath ?? input?.file_path ?? input?.path
        if (toolName === "write" && filePath) return [{ operation: "wrote", path: String(filePath) }]
        if (toolName === "edit" && filePath) return [{ operation: "edited", path: String(filePath) }]
        if (toolName === "bash" && input?.command) return extractFileChangesFromBash(String(input.command))
        return []
      }

      return {
        ...ctx,
        blockedTools: BLOCKED_BUILTIN_TOOLS,
        incompatibleTools: CLAUDE_CODE_ONLY_TOOLS,
        allowedMcpTools: PI_ALLOWED_MCP_TOOLS,
        sdkAgents: {},
        passthrough: resolvePiPassthrough(),
        supportsThinking: true,
        // NoWayLM's OpenClaw runtime drives the pi adapter and injects
        // `<system-reminder>` blocks carrying the host CWD / orchestration
        // context. Strip them from inbound history before flattening so they
        // don't echo back to the model (replay pollution). Same mechanism as
        // Droid — the flag name is about CWD leakage, which is exactly what
        // these reminders carry here.
        leaksCwdViaSystemReminder: true,
        extractFileChangesFromToolUse,
      }
    },
  },
]
