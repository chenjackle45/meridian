# opencode-claude-max-proxy

[![npm version](https://img.shields.io/npm/v/opencode-claude-max-proxy.svg)](https://www.npmjs.com/package/opencode-claude-max-proxy)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![GitHub stars](https://img.shields.io/github/stars/rynfar/opencode-claude-max-proxy.svg)](https://github.com/rynfar/opencode-claude-max-proxy/stargazers)

A transparent proxy that allows a Claude Max subscription to be used with [OpenCode](https://opencode.ai), preserving multi-model agent routing.

OpenCode targets the Anthropic API, while Claude Max provides access to Claude via the [Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk). The proxy forwards tool calls from Claude Max to OpenCode so agent routing works correctly.

Tool execution is handled within the Agent SDK, which is responsible for running tools, coordinating sub-agents, and streaming responses. Because the SDK only has access to Claude models, any tool calls or delegated tasks are executed within that scope. In configurations such as [oh-my-opencode](https://github.com/code-yeongyu/oh-my-opencode), where agents may be assigned to OpenaI, Gemini, or other providers, those assignments are not preserved at execution time, and all work is effectively routed through Claude.

We avoid that limitation by forwarding tool calls instead of executing them. When a `tool_use` event is emitted, the proxy intercepts it, halts the current turn, and sends the raw payload back to OpenCode. OpenCode executes the tool, including any agent routing, and returns the result as a `tool_result`. The proxy then resumes the SDK session.

From Claude’s perspective, tool usage proceeds normally. From OpenCode’s perspective, it is interacting with the Anthropic API. Execution remains distributed according to the configured agents, allowing different models to handle different roles without being constrained by the SDK.

```
┌──────────┐                ┌───────────────┐              ┌──────────────┐
│          │                │               │              │              │
│ OpenCode │ ─────────────► │    Proxy      │ ───────────► │  Claude Max  │
│          │                │  (localhost)  │              │  (Agent SDK) │
│          │                │               │              │              │
│          │                │               │ ◄─────────── │  tool_use    │
│          │                │ ◄──────────── │              │              │
│          │                │  Intercept    │              └──────────────┘
│          │                │  (stop turn)  │
│          │                │       │
│          │                │       ▼
│          │                │  ┌──────────────┐
│          │                │  │  OpenCode    │
│          │                │  │  agent       │
│          │                │  │  system      │
│          │                │  └──────────────┘
│          │                │       │
│          │                │       ▼
│          │                │ ◄────────────
│          │                │  Resume turn
│          │                │
│          │ ◄───────────── │
│          │  response      │
└──────────┘                └───────────────┘
```

## How Passthrough Works

The Claude Agent SDK exposes a `PreToolUse` hook that fires before any tool executes. Combined with `maxTurns: 1`, it gives us precise control over the execution boundary without monkey-patching or stream rewriting.

1. **Claude generates a response** with `tool_use` blocks (Read a file, delegate to an agent, run a command)
2. **The PreToolUse hook fires** for each tool call - we capture the tool name, input, and ID, then return `decision: "block"` to prevent SDK-internal execution
3. **The SDK stops** (blocked tool + maxTurns:1 = turn complete) and we have the full tool_use payload
4. **The proxy returns it to OpenCode** as a standard Anthropic API response with `stop_reason: "tool_use"`
5. **OpenCode handles everything** — file reads, shell commands, and crucially, `Task` delegation through its own agent system with full model routing
6. **OpenCode sends `tool_result` back**, the proxy resumes the SDK session, and Claude continues

## Quick Start

### One-Liner Install

```bash
curl -fsSL https://raw.githubusercontent.com/ianjwhite99/opencode-with-claude/main/install.sh | bash
```

Installs everything (Claude CLI, OpenCode, proxy) and gives you an `oc` command. See [opencode-with-claude](https://github.com/ianjwhite99/opencode-with-claude) for details.

### Prerequisites

1. **Claude Max subscription** — [Subscribe here](https://claude.ai/settings/billing)
2. **Claude CLI** authenticated: `npm install -g @anthropic-ai/claude-code && claude login`
3. **Clear any existing OpenCode Anthropic auth** — if you previously used OpenCode with a real Anthropic API key, log out first or the cached auth will override the proxy:
   ```bash
   opencode auth logout   # select "anthropic" when prompted
   ```

### Option A: npm Install

```bash
npm install -g opencode-claude-max-proxy

# Start in passthrough mode (recommended)
CLAUDE_PROXY_PASSTHROUGH=1 claude-max-proxy
```

### Option B: From Source

```bash
git clone https://github.com/rynfar/opencode-claude-max-proxy
cd opencode-claude-max-proxy
bun install

# Start in passthrough mode (recommended)
CLAUDE_PROXY_PASSTHROUGH=1 bun run proxy
```

> **Note:** Running from source requires [Bun](https://bun.sh): `curl -fsSL https://bun.sh/install | bash`

### Option C: Docker

```bash
git clone https://github.com/rynfar/opencode-claude-max-proxy
cd opencode-claude-max-proxy

# Start the container
docker compose up -d

# Login to Claude inside the container (one-time)
docker compose exec proxy claude login

# Verify
curl http://127.0.0.1:3456/health
```

> **Note:** On macOS, use `./bin/docker-auth.sh` to copy host credentials into the container (handles the keychain/scopes format difference). On Linux, volume-mounting `~/.claude` may work directly.

### Connect OpenCode

#### Per-Terminal Launcher (recommended)

```bash
./bin/oc.sh
```

Each terminal gets its own proxy on a random port. Proxy starts automatically, connects OpenCode, and cleans up on exit. Sessions resume across terminals via a shared file store.

Shell alias:

```bash
# ~/.zshrc or ~/.bashrc
alias oc='/path/to/opencode-claude-max-proxy/bin/oc.sh'
```

#### Shared Proxy

For a single long-running proxy:

```bash
# Terminal 1: start the proxy
CLAUDE_PROXY_PASSTHROUGH=1 bun run proxy

# Terminal 2+: connect OpenCode
ANTHROPIC_API_KEY=dummy ANTHROPIC_BASE_URL=http://127.0.0.1:3456 opencode
```

`ANTHROPIC_API_KEY` can be any non-empty string. Authentication is handled by `claude login`.

#### OpenCode Desktop / Config File

Set the proxy URL in `~/.config/opencode/opencode.json` to use with Desktop or avoid env vars.

```json
{
  "provider": {
    "anthropic": {
      "options": {
        "baseURL": "http://127.0.0.1:3456",
        "apiKey": "dummy"
      }
    }
  }
}
```

> Desktop requires the shared proxy on a fixed port. Run `CLAUDE_PROXY_PASSTHROUGH=1 bun run proxy` in the background. Sessions are shared between Desktop and terminal instances.

## Modes

### Passthrough Mode (recommended)

```bash
CLAUDE_PROXY_PASSTHROUGH=1 bun run proxy
```

All tool execution is forwarded to OpenCode. This enables:

- **Multi-model agent delegation** — oh-my-opencode routes each agent to its configured model
- **Full agent system prompts** — not abbreviated descriptions, the real prompts
- **OpenCode manages everything** — tools, agents, permissions, lifecycle

### Internal Mode (default)

```bash
bun run proxy
```

Tools execute inside the proxy via MCP. Subagents run on Claude via the SDK's native agent system. Simpler setup, but all agents use Claude regardless of oh-my-opencode config.

|                       | Passthrough            | Internal            |
| --------------------- | ---------------------- | ------------------- |
| Tool execution        | OpenCode               | Proxy (MCP)         |
| Agent delegation      | OpenCode → multi-model | SDK → Claude only   |
| oh-my-opencode models | ✅ Respected           | ❌ All Claude       |
| Agent system prompts  | ✅ Full                | ⚠️ Description only |
| Setup complexity      | Same                   | Same                |

## Works With Any Agent Framework

The proxy extracts agent definitions from the `Task` tool description that OpenCode sends in each request. This means it works automatically with:

- **Native OpenCode** — `build` and `plan` agents
- **oh-my-opencode** — `oracle`, `explore`, `librarian`, `sisyphus-junior`, `metis`, `momus`, etc.
- **Custom agents** — anything you define in `opencode.json`

In internal mode, a `PreToolUse` hook fuzzy-matches agent names as a safety net (e.g., `general-purpose` → `general`, `Explore` → `explore`, `code-reviewer` → `oracle`). In passthrough mode, OpenCode handles agent names directly.

## Session Resume

The proxy tracks SDK session IDs and resumes conversations on follow-up requests. Sessions are stored in `~/.cache/opencode-claude-max-proxy/sessions.json`, shared across all proxy instances (including per-terminal proxies).

Lookup order:

1. **Header-based** — add the included OpenCode plugin to inject session headers:

   ```json
   {
     "plugin": [
       "./path/to/opencode-claude-max-proxy/src/plugin/claude-max-headers.ts"
     ]
   }
   ```

2. **Fingerprint-based** (automatic fallback) — hashes the first user message to match returning conversations

Sessions expire after 24 hours.

## Configuration

| Variable                            | Default   | Description                                              |
| ----------------------------------- | --------- | -------------------------------------------------------- |
| `CLAUDE_PROXY_PASSTHROUGH`          | (unset)   | Enable passthrough mode to forward all tools to OpenCode |
| `CLAUDE_PROXY_PORT`                 | 3456      | Proxy server port                                        |
| `CLAUDE_PROXY_HOST`                 | 127.0.0.1 | Proxy server host                                        |
| `CLAUDE_PROXY_WORKDIR`              | (cwd)     | Working directory for Claude and tools                   |
| `CLAUDE_PROXY_MAX_CONCURRENT`       | 1         | Max concurrent SDK sessions (increase with caution)      |
| `CLAUDE_PROXY_IDLE_TIMEOUT_SECONDS` | 120       | Connection idle timeout                                  |

## Concurrency

Per-terminal proxies (`oc.sh`) avoid concurrency issues entirely. Each terminal gets its own proxy.

The shared proxy supports concurrent requests but the SDK's `cli.js` subprocess (compiled with Bun) can segfault during stream cleanup ([oven-sh/bun#17947](https://github.com/oven-sh/bun/issues/17947)). Responses are always delivered correctly; the crash occurs after completion. The supervisor auto-restarts within a few seconds.

## FAQ

<details>
<summary><strong>Why passthrough mode instead of handling tools internally?</strong></summary>

If the Agent SDK executes tools directly, everything runs through Claude. Any agent routing defined in OpenCode is bypassed. Passthrough mode just sends the tool calls to OpenCode to run.

</details>

<details>
<summary><strong>Does this work without oh-my-opencode?</strong></summary>

Yes. Both modes work with native OpenCode (build + plan agents) and with any custom agents defined in your `opencode.json`. oh-my-opencode just adds more agents and model routing. The proxy handles whatever OpenCode sends.

</details>

<details>
<summary><strong>Why do I need `ANTHROPIC_API_KEY=dummy`?</strong></summary>

OpenCode requires an API key to be set, but the proxy never uses it. Authentication is handled by your `claude login` session through the Agent SDK.

</details>

<details>
<summary><strong>What about rate limits?</strong></summary>

Your Claude Max subscription has its own usage limits. The proxy doesn't add any additional limits. Concurrent requests are supported.

</details>

<details>
<summary><strong>Is my data sent anywhere else?</strong></summary>

No. The proxy runs locally. Requests go directly to Claude through the official SDK. In passthrough mode, tool execution happens in OpenCode on your machine.

</details>

<details>
<summary><strong>Why does internal mode use MCP tools?</strong></summary>

The Claude Agent SDK uses different parameter names for tools than OpenCode (e.g., `file_path` vs `filePath`). Internal mode provides its own MCP tools with SDK-compatible parameter names. Passthrough mode doesn't need this since OpenCode handles tool execution directly.

</details>

## Troubleshooting

| Problem                       | Solution                                                                  |
| ----------------------------- | ------------------------------------------------------------------------- |
| "Authentication failed"       | Run `claude login` to authenticate                                        |
| "Connection refused"          | Make sure the proxy is running: `bun run proxy`                           |
| "Port 3456 is already in use" | `kill $(lsof -ti :3456)` or use `CLAUDE_PROXY_PORT=4567`                  |
| Title generation fails        | Set `"small_model": "anthropic/claude-haiku-4-5"` in your OpenCode config |

## Auto-start (macOS)

```bash
cat > ~/Library/LaunchAgents/com.claude-max-proxy.plist << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.claude-max-proxy</string>
    <key>ProgramArguments</key>
    <array>
        <string>$(pwd)/bin/claude-proxy-supervisor.sh</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$(pwd)</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>CLAUDE_PROXY_PASSTHROUGH</key>
        <string>1</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
</dict>
</plist>
EOF

launchctl load ~/Library/LaunchAgents/com.claude-max-proxy.plist
```

## Development

### Run tests

```bash
bun test
```

### Health Endpoint

```bash
curl http://127.0.0.1:3456/health
```

Returns auth status, subscription type, and proxy mode. Use this to verify the proxy is running and authenticated before connecting OpenCode.

### Architecture

```
src/
├── proxy/
│   ├── server.ts      # HTTP server, passthrough/internal modes, SSE streaming, session resume
│   ├── agentDefs.ts   # Extract SDK agent definitions from OpenCode's Task tool
│   ├── agentMatch.ts  # Fuzzy matching for agent names (6-level priority)
│   └── types.ts       # ProxyConfig types and defaults
├── mcpTools.ts        # MCP tool definitions for internal mode (read, write, edit, bash, glob, grep)
├── logger.ts          # Structured logging with AsyncLocalStorage context
├── plugin/
    └── claude-max-headers.ts  # OpenCode plugin for session header injection
```

## Disclaimer

This project is an **unofficial wrapper** around Anthropic's publicly available [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk). It is not affiliated with, endorsed by, or supported by Anthropic.

**Use at your own risk.** The authors make no claims regarding compliance with Anthropic's Terms of Service. It is your responsibility to review and comply with [Anthropic's Terms of Service](https://www.anthropic.com/legal/consumer-terms) and [Authorized Usage Policy](https://www.anthropic.com/legal/aup). Terms may change at any time.

This project calls `query()` from Anthropic's public npm package using your own authenticated account. No API keys are intercepted, no authentication is bypassed, and no proprietary systems are reverse-engineered.

## License

MIT

## Credits

Built with the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) by Anthropic.

[opencode-with-claude](https://github.com/ianjwhite99/opencode-with-claude) installer by [@ianjwhite99](https://github.com/ianjwhite99). Multimodal support based on work by [@juanferreiramorel](https://github.com/juanferreiramorel). Per-terminal proxy idea by [@calebdw](https://github.com/calebdw). README cleanup by [@skipships](https://github.com/skipships).
