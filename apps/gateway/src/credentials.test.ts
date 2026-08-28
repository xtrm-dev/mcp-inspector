import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSdkAdapter } from "@mcp-inspector-x/protocol";
import { openStorage, type Storage } from "@mcp-inspector-x/storage";
import { buildGatewayApp } from "./routes";
import { createServerManager, type ServerManager } from "./servers";
import { createSecretsRegistry, type SecretsRegistry } from "./secrets";

describe("credential registry + env secret provider", () => {
  let dir: string;
  let storage: Storage;
  let app: ReturnType<typeof buildGatewayApp>;
  let serverManager: ServerManager;
  let secrets: SecretsRegistry;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mix-creds-"));
    storage = openStorage({ dataDir: dir });
    const adapter = createSdkAdapter();
    secrets = createSecretsRegistry({ storage, env: { MIX_TEST_TOKEN: "super-secret-value" } });
    serverManager = createServerManager({ storage, adapter, secrets });
    app = buildGatewayApp({ adapter, storage, serverManager, secrets });
  });

  afterEach(() => {
    storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("GET /api/v1/config advertises credentialsV1=true", async () => {
    const r = await app.request("/api/v1/config");
    const body = (await r.json()) as { capabilities?: { credentialsV1?: boolean } };
    expect(body.capabilities?.credentialsV1).toBe(true);
  });

  it("POST /api/v1/credentials creates a metadata-only credential ref (never returns the value)", async () => {
    const r = await app.request("/api/v1/credentials", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "env", key: "MIX_TEST_TOKEN" }),
    });
    expect(r.status).toBe(201);
    const body = (await r.json()) as {
      credentialRef: { id: string; provider: string; key: string; scope: string | null };
    };
    expect(body.credentialRef.provider).toBe("env");
    expect(body.credentialRef.key).toBe("MIX_TEST_TOKEN");
    // Whole-response guard: the resolved secret VALUE must never appear in any
    // credential-management response.
    expect(JSON.stringify(body)).not.toContain("super-secret-value");
  });

  it("GET /api/v1/credentials lists metadata only", async () => {
    await app.request("/api/v1/credentials", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "env", key: "MIX_TEST_TOKEN" }),
    });
    const r = await app.request("/api/v1/credentials");
    const body = (await r.json()) as { credentials: Array<{ key: string }> };
    expect(body.credentials.map((c) => c.key)).toContain("MIX_TEST_TOKEN");
    expect(JSON.stringify(body)).not.toContain("super-secret-value");
  });

  it("DELETE /api/v1/credentials/:id removes the ref", async () => {
    const created = (await (
      await app.request("/api/v1/credentials", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "env", key: "MIX_TEST_TOKEN" }),
      })
    ).json()) as { credentialRef: { id: string } };
    const del = await app.request(`/api/v1/credentials/${created.credentialRef.id}`, {
      method: "DELETE",
    });
    expect(del.status).toBe(200);
    const missing = await app.request(`/api/v1/credentials/${created.credentialRef.id}`, {
      method: "DELETE",
    });
    expect(missing.status).toBe(404);
  });

  it("secrets registry resolves an env credential and adds it to the known-secret set", async () => {
    const ref = storage.credentials.create({ provider: "env", key: "MIX_TEST_TOKEN" });
    const value = await secrets.resolve(ref.id);
    expect(value).toBe("super-secret-value");
    expect(secrets.known().has("super-secret-value")).toBe(true);
  });

  it("resolve() throws with a clear message when the env var is missing", async () => {
    const ref = storage.credentials.create({ provider: "env", key: "MIX_MISSING_ENV" });
    await expect(secrets.resolve(ref.id)).rejects.toThrow(/env var 'MIX_MISSING_ENV'/);
  });

  it("resolve() throws a clear 'runner required' error for the 'os' provider when no runner is configured (Phase I slice 2)", async () => {
    const ref = storage.credentials.create({ provider: "os", key: "anything" });
    await expect(secrets.resolve(ref.id)).rejects.toThrow(/privileged runner/);
  });

  it("resolve() throws a clear error for an unset 'session' secret (Phase I slice 2)", async () => {
    const ref = storage.credentials.create({ provider: "session", key: "anything" });
    await expect(secrets.resolve(ref.id)).rejects.toThrow(/session secret .* is not set/);
  });

  it("session provider round-trips a value via put()/resolve() and forgets it on dispose()", async () => {
    const ref = storage.credentials.create({ provider: "session", key: "my-pat" });
    await secrets.put(ref, "session-secret-value");
    expect(await secrets.resolve(ref.id)).toBe("session-secret-value");
    await secrets.dispose();
    await expect(secrets.resolve(ref.id)).rejects.toThrow(/session secret .* is not set/);
  });

  it("secrets.scrub() replaces every known-secret substring", async () => {
    const ref = storage.credentials.create({ provider: "env", key: "MIX_TEST_TOKEN" });
    await secrets.resolve(ref.id);
    const scrubbed = secrets.scrub(
      "Authorization: Bearer super-secret-value; note: super-secret-value",
    );
    expect(scrubbed).toBe("Authorization: Bearer [REDACTED]; note: [REDACTED]");
  });

  it("Investigation Packet scrub replaces a known-secret value even when the key is not sensitive", async () => {
    // Load the secret so the registry knows it.
    const ref = storage.credentials.create({ provider: "env", key: "MIX_TEST_TOKEN" });
    await secrets.resolve(ref.id);

    // Seed an execution whose result contains the raw secret under a benign key.
    const executionRow = storage.executions.create({
      serverId: "someServer",
      capabilityId: "someServer::tool::echo",
    });
    storage.rounds.append({
      executionId: executionRow.id,
      roundIndex: 0,
      kind: "initial",
      argumentsJson: JSON.stringify({ note: "super-secret-value" }),
      resultInlineJson: JSON.stringify({ echo: "super-secret-value" }),
      resultArtifact: null,
      errorJson: null,
      durationMs: 1,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
    });
    storage.executions.updateStatus(executionRow.id, "complete", new Date().toISOString());

    const r = await app.request("/api/v1/packets/build", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ executionIds: [executionRow.id] }),
    });
    const text = await r.text();
    expect(text).not.toContain("super-secret-value");
    expect(text).toContain("[REDACTED]");
    const parsed = JSON.parse(text) as {
      packet: { redactions: Array<{ path: string; reason: string }> };
    };
    expect(
      parsed.packet.redactions.some((rec) => rec.reason === "known-secret-value-policy"),
    ).toBe(true);
  });

  it("POST /api/v1/credentials with a session provider + inline value seeds the secret in one round trip", async () => {
    const r = await app.request("/api/v1/credentials", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "session",
        key: "spa-inline-key",
        value: "spa-session-secret-2026",
      }),
    });
    expect(r.status).toBe(201);
    const body = (await r.json()) as { credentialRef: { id: string; provider: string } };
    expect(body.credentialRef.provider).toBe("session");
    // The resolver returns the value that was just seeded — no separate write route needed.
    const resolved = await secrets.resolve(body.credentialRef.id);
    expect(resolved).toBe("spa-session-secret-2026");
  });

  it("POST /api/v1/credentials rejects an inline value for the 'env' provider", async () => {
    const r = await app.request("/api/v1/credentials", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "env",
        key: "MIX_TEST_TOKEN",
        value: "must-not-be-accepted",
      }),
    });
    expect(r.status).toBe(400);
  });
});
