import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse, type Server as HttpServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { McpServer, createMcpHandler, type McpHttpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { MODERN_PROTOCOL_VERSION, createSdkAdapter } from "@mcp-inspector-x/protocol";
import { openStorage, type Storage } from "@mcp-inspector-x/storage";
import { buildGatewayApp } from "./routes";
import { createServerManager, type ServerManager } from "./servers";
import { createSecretsRegistry, type SecretsRegistry } from "./secrets";

/**
 * MCP 2026-07-28 authorization end-to-end, against a self-hosted mock
 * issuer — never a real IdP (per bead constraints). One HTTP server plays
 * three roles at once: the protected MCP resource, the RFC 9728 protected-
 * resource metadata endpoint, and the RFC 8414 authorization server (RFC
 * 7591 dynamic registration + RFC 7636 PKCE authorization-code + refresh).
 * `/authorize` auto-approves immediately (302 straight to the redirect_uri)
 * — there is no login page to click through, matching
 * packages/protocol/src/oauth.ts's documented scope (no interactive
 * consent UI this slice).
 */

interface MockOAuthServer {
  url: string;
  /** Directly mutable by tests to simulate token expiry ("the resource
   * server no longer accepts this token") without needing a real clock. */
  validAccessTokens: Set<string>;
  close(): Promise<void>;
}

async function createMockOAuthGuardedServer(): Promise<MockOAuthServer> {
  const clients = new Map<string, { redirect_uris: string[] }>();
  const authCodes = new Map<string, { codeChallenge: string; redirectUri: string }>();
  const validAccessTokens = new Set<string>();
  const refreshTokens = new Map<string, string>(); // refresh_token -> current access_token

  const mcpHandler: McpHttpHandler = createMcpHandler(() => buildGuardedMcpServer());
  const nodeMcpHandler = toNodeHandler(mcpHandler);

  let origin = "";

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", origin);

    if (url.pathname === "/.well-known/oauth-protected-resource") {
      sendJson(res, 200, { resource: `${origin}/`, authorization_servers: [`${origin}/`] });
      return;
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      sendJson(res, 200, {
        issuer: `${origin}/`,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
      return;
    }
    if (url.pathname === "/register" && req.method === "POST") {
      const body = (await readJsonBody(req)) as { redirect_uris?: string[] };
      const clientId = `client_${randomBytes(8).toString("hex")}`;
      clients.set(clientId, { redirect_uris: body.redirect_uris ?? [] });
      sendJson(res, 201, { ...body, client_id: clientId, client_id_issued_at: Math.floor(Date.now() / 1000) });
      return;
    }
    if (url.pathname === "/authorize" && req.method === "GET") {
      const clientId = url.searchParams.get("client_id") ?? "";
      const redirectUri = url.searchParams.get("redirect_uri") ?? "";
      const codeChallenge = url.searchParams.get("code_challenge") ?? "";
      const state = url.searchParams.get("state");
      if (!clients.has(clientId) || !redirectUri) {
        res.writeHead(400, { "content-type": "text/plain" }).end("invalid client_id/redirect_uri");
        return;
      }
      // Auto-approve: this is the whole point of a mock test issuer — no
      // human, no login page. See module docs.
      const code = `code_${randomBytes(16).toString("hex")}`;
      authCodes.set(code, { codeChallenge, redirectUri });
      const dest = new URL(redirectUri);
      dest.searchParams.set("code", code);
      if (state !== null) dest.searchParams.set("state", state);
      res.writeHead(302, { location: dest.toString() });
      res.end();
      return;
    }
    if (url.pathname === "/token" && req.method === "POST") {
      const raw = await readTextBody(req);
      const params = new URLSearchParams(raw);
      const grantType = params.get("grant_type");
      if (grantType === "authorization_code") {
        const code = params.get("code") ?? "";
        const verifier = params.get("code_verifier") ?? "";
        const entry = authCodes.get(code);
        if (!entry) {
          sendJson(res, 400, { error: "invalid_grant" });
          return;
        }
        authCodes.delete(code); // one-time use
        const challenge = createHash("sha256").update(verifier).digest("base64url");
        if (challenge !== entry.codeChallenge) {
          sendJson(res, 400, { error: "invalid_grant", error_description: "PKCE verification failed" });
          return;
        }
        const accessToken = `at_${randomBytes(16).toString("hex")}`;
        const refreshToken = `rt_${randomBytes(16).toString("hex")}`;
        validAccessTokens.add(accessToken);
        refreshTokens.set(refreshToken, accessToken);
        sendJson(res, 200, { access_token: accessToken, token_type: "Bearer", expires_in: 3600, refresh_token: refreshToken });
        return;
      }
      if (grantType === "refresh_token") {
        const refreshToken = params.get("refresh_token") ?? "";
        const oldAccess = refreshTokens.get(refreshToken);
        if (oldAccess === undefined) {
          sendJson(res, 400, { error: "invalid_grant" });
          return;
        }
        validAccessTokens.delete(oldAccess);
        const newAccess = `at_${randomBytes(16).toString("hex")}`;
        validAccessTokens.add(newAccess);
        refreshTokens.set(refreshToken, newAccess);
        sendJson(res, 200, { access_token: newAccess, token_type: "Bearer", expires_in: 3600, refresh_token: refreshToken });
        return;
      }
      sendJson(res, 400, { error: "unsupported_grant_type" });
      return;
    }
    if (url.pathname === "/") {
      const authz = req.headers["authorization"];
      const token = typeof authz === "string" && authz.startsWith("Bearer ") ? authz.slice(7) : undefined;
      if (!token || !validAccessTokens.has(token)) {
        res.writeHead(401, {
          "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
        });
        res.end();
        return;
      }
      await nodeMcpHandler(req as unknown as Parameters<typeof nodeMcpHandler>[0], res);
      return;
    }
    res.writeHead(404).end();
  }

  const server: HttpServer = createServer((req, res) => {
    void route(req, res).catch((err: unknown) => {
      if (!res.headersSent) res.writeHead(500);
      res.end(String(err));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("mock-oauth-server: no bound address");
  origin = `http://127.0.0.1:${addr.port}`;

  return {
    url: `${origin}/`,
    validAccessTokens,
    async close() {
      await mcpHandler.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function buildGuardedMcpServer(): McpServer {
  const mcp = new McpServer(
    { name: "mcp-inspector-x-oauth-test", version: "0.0.1" },
    { supportedProtocolVersions: [MODERN_PROTOCOL_VERSION] },
  );
  mcp.registerTool(
    "whoami",
    {
      title: "Who Am I",
      description: "Returns a constant string, proving the authenticated request reached the tool",
      inputSchema: z.object({}),
      outputSchema: z.object({ who: z.string() }),
    },
    async () => ({
      content: [{ type: "text", text: JSON.stringify({ who: "authorized" }) }],
      structuredContent: { who: "authorized" },
    }),
  );
  return mcp;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

function readTextBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const text = await readTextBody(req);
  return text.length > 0 ? JSON.parse(text) : {};
}

describe("OAuth (remote MCP) — mock issuer end-to-end", () => {
  let mock: MockOAuthServer;
  let dir: string;
  let storage: Storage;
  let app: ReturnType<typeof buildGatewayApp>;
  let serverManager: ServerManager;
  let secrets: SecretsRegistry;

  beforeAll(async () => {
    mock = await createMockOAuthGuardedServer();
  });

  afterAll(async () => {
    await mock?.close();
  });

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "mix-oauth-gw-"));
    storage = openStorage({ dataDir: dir });
    const adapter = createSdkAdapter();
    secrets = createSecretsRegistry({ storage });
    serverManager = createServerManager({ storage, adapter, secrets });
    app = buildGatewayApp({ adapter, storage, serverManager, secrets });
  });

  afterEach(async () => {
    for (const b of serverManager?.bindings() ?? []) {
      await serverManager.disconnect(b.descriptor.id).catch(() => {});
    }
  });

  afterAll(() => {
    storage?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("401 → discovery → DCR → PKCE authorization → resource request succeeds", async () => {
    const ref = storage.credentials.create({ provider: "session", key: "oauth" });
    const def = storage.servers.upsertById({
      id: "oauth-demo",
      displayName: "OAuth-guarded demo",
      transport: "streamable-http",
      endpoint: mock.url,
      protocolPolicy: "modern",
      credentialRefId: ref.id,
    });

    const connectRes = await app.request(`/api/v1/servers/${def.id}/connect`, { method: "POST" });
    expect(connectRes.status).toBe(200);
    const connectBody = (await connectRes.json()) as { connected: boolean };
    expect(connectBody.connected).toBe(true);

    // A token was actually acquired against our mock issuer.
    expect(mock.validAccessTokens.size).toBe(1);

    const toolsRes = await app.request(`/api/v1/servers/${def.id}/tools`);
    expect(toolsRes.status).toBe(200);
    const toolsBody = (await toolsRes.json()) as { tools: Array<{ name: string }> };
    expect(toolsBody.tools.map((t) => t.name)).toContain("whoami");

    const callRes = await app.request(`/api/v1/servers/${def.id}/tools/whoami/call`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ arguments: {} }),
    });
    expect(callRes.status).toBe(200);
    const callBody = (await callRes.json()) as { value: { who: string } };
    expect(callBody.value.who).toBe("authorized");

    // The raw access token never leaks into any user-facing surface — it's
    // only ever addressable via the CredentialRef.
    const executionsRes = await app.request("/api/v1/executions");
    const executionsText = await executionsRes.text();
    for (const token of mock.validAccessTokens) {
      expect(executionsText).not.toContain(token);
    }

    // Belt and suspenders on the central redaction path itself, same as
    // the "env" bearer-token case: even if the raw OAuth access token
    // shows up somewhere unexpected (e.g. a tool echoed a header back),
    // the shared SecretsRegistry.scrub() / Investigation Packet path
    // catches it — `noteSecret()` feeds the OAuth token into the exact
    // same `known` set a static bearer token goes through.
    const [oauthAccessToken] = mock.validAccessTokens;
    const executionRow = storage.executions.create({
      serverId: def.id,
      capabilityId: `${def.id}::tool::whoami`,
    });
    storage.rounds.append({
      executionId: executionRow.id,
      roundIndex: 0,
      kind: "initial",
      argumentsJson: JSON.stringify({}),
      resultInlineJson: JSON.stringify({ echoedHeader: `Bearer ${oauthAccessToken}` }),
      resultArtifact: null,
      errorJson: null,
      durationMs: 1,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
    });
    storage.executions.updateStatus(executionRow.id, "complete", new Date().toISOString());

    const packetRes = await app.request("/api/v1/packets/build", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ executionIds: [executionRow.id] }),
    });
    const packetText = await packetRes.text();
    expect(packetText).not.toContain(oauthAccessToken);
    expect(packetText).toContain("[REDACTED]");
  });

  it("token refresh: expired access token → silent refresh → next request still succeeds", async () => {
    const ref = storage.credentials.create({ provider: "session", key: "oauth" });
    const def = storage.servers.upsertById({
      id: "oauth-refresh-demo",
      displayName: "OAuth-guarded demo (refresh)",
      transport: "streamable-http",
      endpoint: mock.url,
      protocolPolicy: "modern",
      credentialRefId: ref.id,
    });

    const connectRes = await app.request(`/api/v1/servers/${def.id}/connect`, { method: "POST" });
    expect(connectRes.status).toBe(200);

    const firstCall = await app.request(`/api/v1/servers/${def.id}/tools/whoami/call`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ arguments: {} }),
    });
    expect(firstCall.status).toBe(200);

    // Simulate the access token expiring server-side, without touching the
    // refresh token — the SDK transport's own 401 → auth() → refresh →
    // retry cycle (see packages/protocol/src/sdk-adapter.ts +
    // @modelcontextprotocol/client) must recover silently.
    mock.validAccessTokens.clear();

    const secondCall = await app.request(`/api/v1/servers/${def.id}/tools/whoami/call`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ arguments: {} }),
    });
    expect(secondCall.status).toBe(200);
    const secondBody = (await secondCall.json()) as { value: { who: string } };
    expect(secondBody.value.who).toBe("authorized");

    // A fresh access token exists post-refresh (the old one was cleared).
    expect(mock.validAccessTokens.size).toBe(1);
  });
});
