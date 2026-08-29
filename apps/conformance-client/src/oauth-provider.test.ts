import { describe, expect, it } from "vitest";
import {
  DynamicOAuthError,
  DynamicOAuthProvider,
  readOAuthConfigFromEnv,
  type DynamicOAuthConfig,
  type FetchLike,
} from "./oauth-provider.js";

const ISSUER = "https://issuer.example";
const DISCOVERY = `${ISSUER}/.well-known/oauth-authorization-server`;
const TOKEN_EP = `${ISSUER}/oauth/token`;

const baseCfg: DynamicOAuthConfig = {
  issuer: ISSUER,
  clientId: "conformance-client",
  redirectUri: "http://127.0.0.1:0/cb",
  refreshToken: "rt-initial",
  scopes: "mcp:read mcp:call",
};

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface StubCall {
  url: string;
  init?: RequestInit;
}

function makeFetch(handlers: Array<(call: StubCall) => Response | Promise<Response>>): {
  fetchFn: FetchLike;
  calls: StubCall[];
} {
  const calls: StubCall[] = [];
  let i = 0;
  const fetchFn: FetchLike = async (input, init) => {
    const call: StubCall = { url: String(input) };
    if (init !== undefined) call.init = init;
    calls.push(call);
    const handler = handlers[i++];
    if (!handler) throw new Error(`no stub handler for call ${i}: ${call.url}`);
    return handler(call);
  };
  return { fetchFn, calls };
}

describe("readOAuthConfigFromEnv", () => {
  it("returns undefined when required vars are missing", () => {
    expect(readOAuthConfigFromEnv({})).toBeUndefined();
    expect(
      readOAuthConfigFromEnv({
        MCP_CONFORMANCE_OAUTH_ISSUER: ISSUER,
        MCP_CONFORMANCE_OAUTH_CLIENT_ID: "id",
        // missing redirect + refresh
      }),
    ).toBeUndefined();
  });

  it("reads full config including optional secret + scopes", () => {
    const cfg = readOAuthConfigFromEnv({
      MCP_CONFORMANCE_OAUTH_ISSUER: ISSUER,
      MCP_CONFORMANCE_OAUTH_CLIENT_ID: "id",
      MCP_CONFORMANCE_OAUTH_CLIENT_SECRET: "shh",
      MCP_CONFORMANCE_OAUTH_REDIRECT_URI: "http://127.0.0.1:0/cb",
      MCP_CONFORMANCE_OAUTH_REFRESH_TOKEN: "rt",
      MCP_CONFORMANCE_OAUTH_SCOPES: "a b",
    });
    expect(cfg).toEqual({
      issuer: ISSUER,
      clientId: "id",
      clientSecret: "shh",
      redirectUri: "http://127.0.0.1:0/cb",
      refreshToken: "rt",
      scopes: "a b",
    });
  });
});

describe("DynamicOAuthProvider.getAccessToken", () => {
  it("discovers the token endpoint and exchanges the refresh_token", async () => {
    const { fetchFn, calls } = makeFetch([
      () => jsonRes({ token_endpoint: TOKEN_EP }),
      () => jsonRes({ access_token: "at-1", expires_in: 3600, token_type: "Bearer" }),
    ]);
    const p = new DynamicOAuthProvider(baseCfg, { fetchFn, now: () => 1_000_000 });
    const tok = await p.getAccessToken();
    expect(tok).toBe("at-1");
    expect(calls[0]!.url).toBe(DISCOVERY);
    expect(calls[1]!.url).toBe(TOKEN_EP);
    const body = String(calls[1]!.init!.body);
    expect(body).toContain("grant_type=refresh_token");
    expect(body).toContain("refresh_token=rt-initial");
    expect(body).toContain("client_id=conformance-client");
    expect(body).toContain("scope=mcp%3Aread+mcp%3Acall");
    expect(body).not.toContain("client_secret");
  });

  it("includes client_secret when configured (confidential client)", async () => {
    const { fetchFn, calls } = makeFetch([
      () => jsonRes({ token_endpoint: TOKEN_EP }),
      () => jsonRes({ access_token: "at-1", expires_in: 60 }),
    ]);
    const p = new DynamicOAuthProvider({ ...baseCfg, clientSecret: "shh" }, { fetchFn, now: () => 0 });
    await p.getAccessToken();
    expect(String(calls[1]!.init!.body)).toContain("client_secret=shh");
  });

  it("falls back to ${issuer}/token when discovery fails", async () => {
    const { fetchFn, calls } = makeFetch([
      () => new Response("not found", { status: 404 }),
      () => jsonRes({ access_token: "at-fallback", expires_in: 60 }),
    ]);
    const p = new DynamicOAuthProvider(baseCfg, { fetchFn, now: () => 0 });
    expect(await p.getAccessToken()).toBe("at-fallback");
    expect(calls[1]!.url).toBe(`${ISSUER}/token`);
  });

  it("caches the token until near expiry", async () => {
    const { fetchFn, calls } = makeFetch([
      () => jsonRes({ token_endpoint: TOKEN_EP }),
      () => jsonRes({ access_token: "at-cached", expires_in: 3600 }),
    ]);
    let now = 0;
    const p = new DynamicOAuthProvider(baseCfg, { fetchFn, now: () => now });
    expect(await p.getAccessToken()).toBe("at-cached");
    now = 60_000; // well before expiry
    expect(await p.getAccessToken()).toBe("at-cached");
    expect(calls.length).toBe(2); // discovery + one token call only
  });

  it("refreshes when the cached token is within the skew window of expiry", async () => {
    const { fetchFn, calls } = makeFetch([
      () => jsonRes({ token_endpoint: TOKEN_EP }),
      () => jsonRes({ access_token: "at-1", expires_in: 60 }),
      () => jsonRes({ access_token: "at-2", expires_in: 60 }),
    ]);
    let now = 0;
    const p = new DynamicOAuthProvider(baseCfg, { fetchFn, now: () => now });
    expect(await p.getAccessToken()).toBe("at-1");
    now = 60_000; // inside 30s skew of the 60s TTL — must refresh
    expect(await p.getAccessToken()).toBe("at-2");
    expect(calls.length).toBe(3);
    expect(calls[2]!.url).toBe(TOKEN_EP);
  });

  it("surfaces 401 as DynamicOAuthError kind=http with status", async () => {
    const { fetchFn } = makeFetch([
      () => jsonRes({ token_endpoint: TOKEN_EP }),
      () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 401 }),
    ]);
    const p = new DynamicOAuthProvider(baseCfg, { fetchFn, now: () => 0 });
    await expect(p.getAccessToken()).rejects.toMatchObject({
      name: "DynamicOAuthError",
      kind: "http",
      status: 401,
    });
  });

  it("surfaces network failure as DynamicOAuthError kind=network", async () => {
    const { fetchFn } = makeFetch([
      () => jsonRes({ token_endpoint: TOKEN_EP }),
      () => {
        throw new TypeError("fetch failed: ECONNREFUSED");
      },
    ]);
    const p = new DynamicOAuthProvider(baseCfg, { fetchFn, now: () => 0 });
    const err = await p.getAccessToken().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DynamicOAuthError);
    expect((err as DynamicOAuthError).kind).toBe("network");
  });

  it("surfaces missing access_token as DynamicOAuthError kind=malformed", async () => {
    const { fetchFn } = makeFetch([
      () => jsonRes({ token_endpoint: TOKEN_EP }),
      () => jsonRes({ token_type: "Bearer", expires_in: 60 }),
    ]);
    const p = new DynamicOAuthProvider(baseCfg, { fetchFn, now: () => 0 });
    await expect(p.getAccessToken()).rejects.toMatchObject({
      name: "DynamicOAuthError",
      kind: "malformed",
    });
  });

  it("surfaces non-JSON body as DynamicOAuthError kind=malformed", async () => {
    const { fetchFn } = makeFetch([
      () => jsonRes({ token_endpoint: TOKEN_EP }),
      () => new Response("<html>gateway timeout</html>", { status: 200, headers: { "content-type": "text/html" } }),
    ]);
    const p = new DynamicOAuthProvider(baseCfg, { fetchFn, now: () => 0 });
    await expect(p.getAccessToken()).rejects.toMatchObject({
      name: "DynamicOAuthError",
      kind: "malformed",
    });
  });
});
