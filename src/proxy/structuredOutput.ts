import type { OutputFormat } from "@anthropic-ai/claude-agent-sdk"

export type OutputFormatParseResult =
  | { ok: true; value: OutputFormat | undefined }
  | { ok: false; message: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/**
 * Parse Anthropic's `output_config.format` into the Claude Agent SDK's native
 * structured-output option. Absence is a no-op; malformed or unsupported
 * values are rejected at the HTTP boundary instead of failing in the SDK.
 *
 * Combining `tools` with `output_config.format` is rejected: structured-output
 * mode buffers the SDK's wire events and replaces the response content with the
 * validated result, so a tool_use turn would be swallowed and the client-driven
 * tool loop would never see it.
 */
export function parseOutputFormat(outputConfig: unknown, tools?: unknown): OutputFormatParseResult {
  if (outputConfig === undefined) return { ok: true, value: undefined }
  if (!isRecord(outputConfig)) {
    return { ok: false, message: "output_config: Expected an object" }
  }

  const format = outputConfig.format
  if (format === undefined) return { ok: true, value: undefined }
  if (!isRecord(format)) {
    return { ok: false, message: "output_config.format: Expected an object" }
  }
  if (format.type !== "json_schema") {
    return { ok: false, message: "output_config.format.type: Only 'json_schema' is supported" }
  }
  if (!isRecord(format.schema)) {
    return { ok: false, message: "output_config.format.schema: Expected a JSON Schema object" }
  }
  if (Array.isArray(tools) && tools.length > 0) {
    return { ok: false, message: "output_config.format: Cannot be combined with tools" }
  }

  return {
    ok: true,
    value: { type: "json_schema", schema: format.schema },
  }
}

export function structuredOutputText(value: unknown): string {
  return JSON.stringify(value)
}
