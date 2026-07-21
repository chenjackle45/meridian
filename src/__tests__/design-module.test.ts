/**
 * Unit tests for src/proxy/design.ts — the Claude Design MCP proxy module.
 *
 * Covers the pure/injected logic: token freshness + refresh-on-expiry,
 * auth-header precedence (design token → API key → OAuth token → Max
 * credential store), forward/response header construction, the 404-as-auth
 * quirk, and the /design-login OAuth session lifecycle. From #543 by
 * @sittitep.
 */
import { describe, it, expect } from "bun:test"
import {
  DESIGN_SCOPES,
  type DesignTokenData,
  type DesignTokenStore,
  isDesignTokenFresh,
  getDesignAccessToken,
  resolveDesignAuthHeaders,
  buildDesignForwardHeaders,
  filterUpstreamResponseHeaders,
  isDesignAuthFailure,
  createDesignLogin,
} from "../proxy/design"

function memoryStore(initial: DesignTokenData | null = null): DesignTokenStore & { data: DesignTokenData | null } {
  const box = {
    data: initial,
    async read() { return box.data },
    async write(d: DesignTokenData) { box.data = d },
  }
  return box
}

const NOW = 1_800_000_000_000

describe("isDesignTokenFresh", () => {
  it("is fresh well before expiry and stale after", () => {
    expect(isDesignTokenFresh({ accessToken: "t", expiresAt: NOW + 3_600_000 }, NOW)).toBe(true)
    expect(isDesignTokenFresh({ accessToken: "t", expiresAt: NOW - 1 }, NOW)).toBe(false)
  })

  it("treats tokens inside the 60s skew window as stale", () => {
    expect(isDesignTokenFresh({ accessToken: "t", expiresAt: NOW + 30_000 }, NOW)).toBe(false)
  })
})

describe("getDesignAccessToken", () => {
  it("returns the stored token when fresh", async () => {
    const store = memoryStore({ accessToken: "fresh-token", expiresAt: NOW + 3_600_000 })
    const token = await getDesignAccessToken({ store, now: NOW, fetchFn: () => { throw new Error("no fetch expected") } })
    expect(token).toBe("fresh-token")
  })

  it("returns null with no stored token", async () => {
    const token = await getDesignAccessToken({ store: memoryStore(), now: NOW })
    expect(token).toBeNull()
  })

  it("refreshes an expired token and persists the result", async () => {
    const store = memoryStore({ accessToken: "old", refreshToken: "refresh-1", expiresAt: NOW - 1000, scopes: DESIGN_SCOPES })
    const calls: any[] = []
    const fetchFn = (async (url: any, init: any) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) })
      return new Response(JSON.stringify({ access_token: "new-token", refresh_token: "refresh-2", expires_in: 28800 }), { status: 200 })
    })
    const token = await getDesignAccessToken({ store, now: NOW, fetchFn })
    expect(token).toBe("new-token")
    expect(calls).toHaveLength(1)
    expect(calls[0].body.grant_type).toBe("refresh_token")
    expect(calls[0].body.refresh_token).toBe("refresh-1")
    expect(store.data?.accessToken).toBe("new-token")
    expect(store.data?.refreshToken).toBe("refresh-2")
    expect(store.data?.expiresAt).toBe(NOW + 28800 * 1000)
  })

  it("keeps the old refresh token when the response omits one", async () => {
    const store = memoryStore({ accessToken: "old", refreshToken: "refresh-1", expiresAt: NOW - 1000 })
    const fetchFn = (async () =>
      new Response(JSON.stringify({ access_token: "new-token", expires_in: 3600 }), { status: 200 }))
    await getDesignAccessToken({ store, now: NOW, fetchFn })
    expect(store.data?.refreshToken).toBe("refresh-1")
  })

  it("returns null when expired with no refresh token", async () => {
    const store = memoryStore({ accessToken: "old", expiresAt: NOW - 1000 })
    const token = await getDesignAccessToken({ store, now: NOW, fetchFn: () => { throw new Error("no fetch expected") } })
    expect(token).toBeNull()
  })

  it("returns null when the refresh request fails", async () => {
    const store = memoryStore({ accessToken: "old", refreshToken: "refresh-1", expiresAt: NOW - 1000 })
    const fetchFn = (async () => new Response("nope", { status: 400 }))
    const token = await getDesignAccessToken({ store, now: NOW, fetchFn })
    expect(token).toBeNull()
  })
})

describe("resolveDesignAuthHeaders", () => {
  it("prefers the design token over everything else", async () => {
    const headers = await resolveDesignAuthHeaders({
      designToken: "design-t",
      profile: { type: "api", env: { ANTHROPIC_API_KEY: "sk-key" } },
    })
    expect(headers).toEqual({ Authorization: "Bearer design-t" })
  })

  it("falls back to the profile API key", async () => {
    const headers = await resolveDesignAuthHeaders({
      designToken: null,
      profile: { type: "api", env: { ANTHROPIC_API_KEY: "sk-key" } },
    })
    expect(headers).toEqual({ "x-api-key": "sk-key" })
  })

  it("falls back to the profile OAuth token", async () => {
    const headers = await resolveDesignAuthHeaders({
      designToken: null,
      profile: { type: "oauth-token", env: { CLAUDE_CODE_OAUTH_TOKEN: "oauth-t" } },
    })
    expect(headers).toEqual({ Authorization: "Bearer oauth-t" })
  })

  it("falls back to the Max credential store access token", async () => {
    const headers = await resolveDesignAuthHeaders({
      designToken: null,
      profile: { type: "claude-max", env: {} },
      credentialStore: { read: async () => ({ claudeAiOauth: { accessToken: "max-t" } }) } as any,
    })
    expect(headers).toEqual({ Authorization: "Bearer max-t" })
  })

  it("returns empty headers when nothing is available", async () => {
    const headers = await resolveDesignAuthHeaders({
      designToken: null,
      profile: { type: "claude-max", env: {} },
    })
    expect(headers).toEqual({})
  })
})

describe("buildDesignForwardHeaders", () => {
  const get = (headers: Record<string, string>) => (name: string) => headers[name.toLowerCase()]

  it("defaults anthropic-version and forces identity encoding", () => {
    const h = buildDesignForwardHeaders(get({}), { Authorization: "Bearer t" })
    expect(h["anthropic-version"]).toBe("2023-06-01")
    expect(h["accept-encoding"]).toBe("identity")
    expect(h["Authorization"]).toBe("Bearer t")
  })

  it("forwards content-type, anthropic-beta, anthropic-version, and mcp-session-id when present", () => {
    const h = buildDesignForwardHeaders(
      get({
        "content-type": "application/json",
        "anthropic-beta": "mcp-2025",
        "anthropic-version": "2024-01-01",
        "mcp-session-id": "sess-9",
      }),
      {},
    )
    expect(h["content-type"]).toBe("application/json")
    expect(h["anthropic-beta"]).toBe("mcp-2025")
    expect(h["anthropic-version"]).toBe("2024-01-01")
    expect(h["mcp-session-id"]).toBe("sess-9")
  })
})

describe("filterUpstreamResponseHeaders", () => {
  it("drops hop-by-hop headers and keeps the rest", () => {
    const out = filterUpstreamResponseHeaders([
      ["content-type", "application/json"],
      ["mcp-session-id", "sess-1"],
      ["Transfer-Encoding", "chunked"],
      ["Connection", "keep-alive"],
      ["keep-alive", "timeout=5"],
    ])
    expect(out).toEqual({ "content-type": "application/json", "mcp-session-id": "sess-1" })
  })
})

describe("isDesignAuthFailure", () => {
  it("treats 401 and the Design API's 404-for-missing-scopes as auth failures", () => {
    expect(isDesignAuthFailure(401)).toBe(true)
    expect(isDesignAuthFailure(404)).toBe(true)
    expect(isDesignAuthFailure(200)).toBe(false)
    expect(isDesignAuthFailure(500)).toBe(false)
  })
})

describe("createDesignLogin", () => {
  const sessionFactory = (() => {
    let n = 0
    return (scopes: string[]) => {
      n++
      return { authorizeUrl: `https://auth.example/${n}?scope=${encodeURIComponent(scopes.join(" "))}`, codeVerifier: `verifier-${n}`, state: `state-${n}` }
    }
  })()

  it("start() returns an authorize URL with the design scopes", () => {
    const login = createDesignLogin({ store: memoryStore(), createSession: sessionFactory, now: () => NOW })
    const res = login.start()
    expect(res.authorizeUrl).toContain("user%3Adesign%3Aread")
  })

  it("exchange() trades the code for a token and persists it", async () => {
    const store = memoryStore()
    const calls: any[] = []
    const fetchFn = (async (_url: any, init: any) => {
      calls.push(JSON.parse(init.body))
      return new Response(JSON.stringify({ access_token: "design-token", refresh_token: "design-refresh", expires_in: 28800, scope: DESIGN_SCOPES.join(" ") }), { status: 200 })
    })
    const login = createDesignLogin({ store, createSession: sessionFactory, fetchFn, now: () => NOW })
    const { state } = login.startRaw()
    const result = await login.exchange({ code: `some-code#${state}` })
    expect(result.status).toBe(200)
    expect((result.body as any).success).toBe(true)
    expect(calls[0].grant_type).toBe("authorization_code")
    expect(calls[0].code).toBe("some-code")
    expect(store.data?.accessToken).toBe("design-token")
    expect(store.data?.refreshToken).toBe("design-refresh")
  })

  it("exchange() rejects an unknown or expired state", async () => {
    const login = createDesignLogin({ store: memoryStore(), createSession: sessionFactory, now: () => NOW })
    const result = await login.exchange({ code: "some-code#state-does-not-exist" })
    expect(result.status).toBe(400)
    expect((result.body as any).error.type).toBe("session_expired")
  })

  it("exchange() rejects a missing code", async () => {
    const login = createDesignLogin({ store: memoryStore(), createSession: sessionFactory, now: () => NOW })
    const result = await login.exchange({})
    expect(result.status).toBe(400)
    expect((result.body as any).error.type).toBe("invalid_request")
  })

  it("sessions are single-use", async () => {
    const store = memoryStore()
    const fetchFn = (async () =>
      new Response(JSON.stringify({ access_token: "t", expires_in: 60 }), { status: 200 }))
    const login = createDesignLogin({ store, createSession: sessionFactory, fetchFn, now: () => NOW })
    const { state } = login.startRaw()
    expect((await login.exchange({ code: `c#${state}` })).status).toBe(200)
    expect((await login.exchange({ code: `c#${state}` })).status).toBe(400)
  })

  it("sessions expire after 10 minutes", async () => {
    const store = memoryStore()
    let now = NOW
    const login = createDesignLogin({ store, createSession: sessionFactory, now: () => now })
    const { state } = login.startRaw()
    now += 11 * 60 * 1000
    const result = await login.exchange({ code: `c#${state}` })
    expect(result.status).toBe(400)
    expect((result.body as any).error.type).toBe("session_expired")
  })

  it("a failed token exchange surfaces as 502", async () => {
    const fetchFn = (async () => new Response("denied", { status: 403 }))
    const login = createDesignLogin({ store: memoryStore(), createSession: sessionFactory, fetchFn, now: () => NOW })
    const { state } = login.startRaw()
    const result = await login.exchange({ code: `c#${state}` })
    expect(result.status).toBe(502)
    expect((result.body as any).error.type).toBe("token_exchange_failed")
  })
})
