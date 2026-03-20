# opencode-claude-max-proxy

[![npm version](https://img.shields.io/npm/v/opencode-claude-max-proxy.svg)](https://www.npmjs.com/package/opencode-claude-max-proxy)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![GitHub stars](https://img.shields.io/github/stars/rynfar/opencode-claude-max-proxy.svg)](https://github.com/rynfar/opencode-claude-max-proxy/stargazers)

Use your **Claude Max subscription** with [OpenCode](https://opencode.ai) — including full tool execution, multi-turn agentic workflows, and subagent delegation.

## What This Does

This proxy lets you use your existing Claude Max subscription with [OpenCode](https://opencode.ai) and other tools that speak the Anthropic API format. It works by wrapping the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) — Anthropic's official npm package for programmatic Claude access.

```
OpenCode → Proxy (localhost:3456) → Claude Agent SDK → Your Claude Max Subscription
```

The proxy translates Anthropic API requests into Claude Agent SDK calls, handles tool execution internally via MCP tools, and streams responses back in the standard Anthropic SSE format.

## Disclaimer

This project is an **unofficial wrapper** around Anthropic's publicly available [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk). It is not affiliated with, endorsed by, or supported by Anthropic.

**Use at your own risk.** The authors make no claims regarding compliance with Anthropic's Terms of Service. It is your responsibility to review and comply with [Anthropic's Terms of Service](https://www.anthropic.com/terms) and any applicable usage policies before using this tool. Terms may change at any time.

This project simply calls `query()` from Anthropic's public npm package using your own authenticated account. No API keys are intercepted, no authentication is bypassed, and no proprietary systems are reverse-engineered.

## Features

| Feature | Description |
|---------|-------------|
| **Zero API costs** | Uses your Claude Max subscription, not per-token billing |
| **Full tool execution** | Read files, write files, run bash commands, search codebases |
| **Subagent support** | Delegate tasks to specialized agents (explore, oracle, librarian, etc.) |
| **Multi-turn agentic loops** | Claude can use tools, see results, and continue — up to 100 turns |
| **Streaming support** | Real-time SSE streaming just like the real API |
| **Concurrent requests** | Subagents and title generation don't block each other |
| **Any Anthropic model** | Works with opus, sonnet, and haiku |
| **Session resume** | Conversations persist across requests — faster responses, better context |
| **Full test coverage** | 50 tests covering tool execution, streaming, subagents, sessions, and concurrency |

## Prerequisites

1. **Claude Max subscription** — [Subscribe here](https://claude.ai/settings/subscription)

2. **Claude CLI** installed and authenticated:
   ```bash
   npm install -g @anthropic-ai/claude-code
   claude login
   ```

3. **Bun** runtime:
   ```bash
   curl -fsSL https://bun.sh/install | bash
   ```

## Installation

```bash
git clone https://github.com/rynfar/opencode-claude-max-proxy
cd opencode-claude-max-proxy
bun install
```

## Usage

### Start the Proxy

```bash
bun run proxy
```

### Run OpenCode

```bash
ANTHROPIC_API_KEY=dummy ANTHROPIC_BASE_URL=http://127.0.0.1:3456 opencode
```

Select any `anthropic/claude-*` model (sonnet, opus, haiku). The `ANTHROPIC_API_KEY` can be any non-empty string — the proxy doesn't use it. Authentication is handled by your `claude login` session.

### One-liner

```bash
bun run proxy & ANTHROPIC_API_KEY=dummy ANTHROPIC_BASE_URL=http://127.0.0.1:3456 opencode
```

### Shell Alias

Add to `~/.zshrc` or `~/.bashrc`:

```bash
alias oc='ANTHROPIC_API_KEY=dummy ANTHROPIC_BASE_URL=http://127.0.0.1:3456 opencode'
```

Then just run `oc`.

## How It Works

```
┌──────────┐     HTTP      ┌───────────────┐    SDK     ┌──────────────┐
│ OpenCode │  ──────────►  │    Proxy      │  ───────►  │  Claude Max  │
│          │  ◄──────────  │  (localhost)   │  ◄───────  │ Subscription │
└──────────┘   SSE/JSON    └───────┬───────┘            └──────────────┘
                                   │
                              ┌────┴────┐
                              │MCP Tools│
                              │read     │
                              │write    │
                              │edit     │
                              │bash     │
                              │glob     │
                              │grep     │
                              └─────────┘
```

### Request Flow

1. **OpenCode** sends Anthropic API requests to `http://127.0.0.1:3456/v1/messages`
2. **Proxy** converts messages to a text prompt for the Claude Agent SDK
3. **Claude Agent SDK** authenticates via your `claude login` session (Max subscription)
4. **Claude** processes the request and can use **MCP tools** (read, write, edit, bash, glob, grep) to interact with your filesystem
5. **Proxy** streams the response back in Anthropic SSE format
6. **OpenCode** receives the response as if it came from the real Anthropic API

### Tool Execution

The proxy provides Claude with 6 MCP tools for filesystem and shell access:

| Tool | Description |
|------|-------------|
| `read` | Read file contents |
| `write` | Write/create files (auto-creates directories) |
| `edit` | Find and replace text in files |
| `bash` | Execute shell commands (120s timeout) |
| `glob` | Find files matching patterns |
| `grep` | Search file contents with regex |

Claude uses these tools **internally** — the tool execution happens inside the proxy, so OpenCode doesn't need to know about them. OpenCode only sees the final text response.

### Subagent Delegation

When OpenCode uses the `Task` tool to delegate work to a subagent (e.g., `explore`, `oracle`, `librarian`), the proxy:

1. **Forwards** the `Task` tool call to OpenCode (so it can manage the subagent lifecycle)
2. **Normalizes** agent names to lowercase (Claude sometimes sends "Explore" instead of "explore")
3. **Filters** internal MCP tool calls from the stream (OpenCode only sees tools it can handle)

This means subagent delegation works with any agent framework (oh-my-opencode, custom agents, or OpenCode's built-in agents).

### Session Resume

The proxy tracks Claude SDK session IDs and resumes conversations on follow-up requests instead of starting fresh. This means:

- **Faster responses** — no re-processing of the entire conversation history
- **Better context** — the SDK remembers tool results from previous turns
- **Less token usage** — only the new user message is sent on resume

Session tracking works two ways:

1. **Header-based** (recommended) — Install the included OpenCode plugin to inject `x-opencode-session` headers:

   ```json
   {
     "plugin": ["./path/to/opencode-claude-max-proxy/src/plugin/claude-max-headers.ts"]
   }
   ```

2. **Fingerprint-based** (automatic fallback) — The proxy hashes the first user message to identify returning conversations. No configuration needed, but less reliable than headers.

Sessions are cached for 1 hour and cleaned up automatically.

## Model Mapping

| OpenCode Model | Claude SDK |
|----------------|------------|
| `anthropic/claude-opus-*` | opus |
| `anthropic/claude-sonnet-*` | sonnet (default) |
| `anthropic/claude-haiku-*` | haiku |

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `CLAUDE_PROXY_PORT` | 3456 | Proxy server port |
| `CLAUDE_PROXY_HOST` | 127.0.0.1 | Proxy server host |
| `CLAUDE_PROXY_WORKDIR` | (process cwd) | Working directory for MCP file/shell tools |
| `CLAUDE_PROXY_IDLE_TIMEOUT_SECONDS` | 120 | Connection idle timeout |

## Auto-start on macOS

Set up the proxy to run automatically on login:

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
        <string>$(which bun)</string>
        <string>run</string>
        <string>proxy</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$(pwd)</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
</dict>
</plist>
EOF

launchctl load ~/Library/LaunchAgents/com.claude-max-proxy.plist
```

## Running Tests

```bash
bun test
```

50 tests covering:
- Tool use forwarding (streaming and non-streaming)
- MCP tool filtering (internal tools hidden from client)
- Subagent concurrent request handling
- Agent name normalization
- Session resume (header-based and fingerprint-based)
- Full Anthropic API tool loop simulation
- Error recovery

## Known Limitations

### Cosmetic: Duplicate Subagent Calls

When Claude delegates to a subagent (e.g., `explore`), you may briefly see a ✓ (success) followed by a ✗ (failure) for the same task in the OpenCode UI:

```
• Find test files  Explore Agent
✓ Find test files  Explore Agent     ← First call succeeds (proxy normalized the name)
✗ task failed: Unknown agent type    ← SDK internal retry (proxy can't intercept this)
```

**This is cosmetic only.** The first call succeeds and returns the correct result. The second call is an internal retry from the Claude Agent SDK that the proxy cannot intercept. Claude ignores the error and uses the result from the successful first call. The final answer is always correct.

### Title Generation

OpenCode uses a `small_model` for generating session titles. If you don't have an API key configured for the small model provider (e.g., Google Gemini), title generation will fail silently. This doesn't affect functionality — just session titles.

Fix: Set a small model that routes through the proxy in your OpenCode config:

```json
{
  "small_model": "anthropic/claude-haiku-4-5"
}
```

## FAQ

### Why do I need `ANTHROPIC_API_KEY=dummy`?

OpenCode requires an API key to be set, but the proxy never uses it. The Claude Agent SDK handles authentication through your `claude login` session. Any non-empty string works.

### Does this work with other tools besides OpenCode?

Yes! Any tool that uses the Anthropic API format can use this proxy. Just point `ANTHROPIC_BASE_URL` to `http://127.0.0.1:3456`.

### Does this work with oh-my-opencode?

Yes. The proxy is compatible with oh-my-opencode agents. Subagent delegation works with any agent names configured in your oh-my-opencode setup.

### What about rate limits?

Your Claude Max subscription has its own usage limits. The proxy doesn't add any additional limits. Concurrent requests are supported.

### Is my data sent anywhere else?

No. The proxy runs locally on your machine. Your requests go directly to Claude through the official SDK.

### Why does the proxy use MCP tools instead of OpenCode's tools?

The Claude Agent SDK uses different parameter names for tools than OpenCode (e.g., `file_path` vs `filePath`). The proxy provides its own MCP tools with parameter names that the SDK understands, then executes them internally. This avoids parameter mismatch errors and gives Claude reliable tool access.

## Troubleshooting

### "Authentication failed"

Run `claude login` to authenticate with the Claude CLI.

### "Connection refused" / "Unable to connect"

Make sure the proxy is running: `bun run proxy`

### "Port 3456 is already in use"

Another instance of the proxy (or another service) is using port 3456.

```bash
# Check what's using the port
lsof -i :3456

# Kill it
kill $(lsof -ti :3456)

# Or use a different port
CLAUDE_PROXY_PORT=4567 bun run proxy
```

### Proxy keeps dying

Use the launchd service (see Auto-start section) which automatically restarts the proxy. Or run with `nohup`:

```bash
nohup bun run proxy > /tmp/claude-proxy.log 2>&1 &
```

### OpenCode shows "0.0.0-claude-max-patches" version

You have an old patched OpenCode binary or shell alias. Check:

```bash
which opencode          # Should be ~/.opencode/bin/opencode
alias opencode          # Should not exist
grep opencode ~/.zshrc  # Remove any alias lines
```

## Architecture

```
src/
├── proxy/
│   ├── server.ts    # HTTP server, request handling, SSE streaming, session resume, MCP filtering
│   └── types.ts     # ProxyConfig types and defaults
├── mcpTools.ts      # MCP tool definitions (read, write, edit, bash, glob, grep)
├── logger.ts        # Structured logging with AsyncLocalStorage context
├── plugin/
│   └── claude-max-headers.ts  # OpenCode plugin for session header injection
└── __tests__/       # 46 tests across 7 files
    ├── helpers.ts
    ├── integration.test.ts
    ├── proxy-agent-normalization.test.ts
    ├── proxy-mcp-filtering.test.ts
    ├── proxy-session-resume.test.ts
    ├── proxy-subagent-support.test.ts
    ├── proxy-tool-forwarding.test.ts
    └── proxy-transparent-tools.test.ts
```

## License

MIT

## Credits

Built with the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) by Anthropic.
