import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSdkAdapter } from "@mcp-inspector-x/protocol";
import { openStorage, type Storage } from "@mcp-inspector-x/storage";
import { buildGatewayApp } from "./routes";
import { createServerManager, type ServerManager } from "./servers";
import { createSecretsRegistry } from "./secrets";

describe("source-revision substrate (Phase M slice 2)", () => {
  let storage: Storage;
  let app: ReturnType<typeof buildGatewayApp>;
  let serverManager: ServerManager;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mix-source-"));
    storage = openStorage({ dataDir: dir });
    const adapter = createSdkAdapter();
    const secrets = createSecretsRegistry({ storage });
    serverManager = createServerManager({ storage, adapter, secrets });
    app = buildGatewayApp({ adapter, storage, serverManager, secrets });
  });

  afterEach(() => {
    storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("/api/v1/config advertises sourceRevisionsV1=true", async () => {
    const r = await app.request("/api/v1/config");
    const body = (await r.json()) as { capabilities?: { sourceRevisionsV1?: boolean } };
    expect(body.capabilities?.sourceRevisionsV1).toBe(true);
  });

  it("POST /api/v1/source/revisions registers a revision with an auto-derived shortSha", async () => {
    const r = await app.request("/api/v1/source/revisions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repositoryRef: "xtrm-dev/mcp-inspector",
        revisionHash: "abc1234def5678900000000000000000000abcde",
        branch: "dev",
      }),
    });
    expect(r.status).toBe(201);
    const body = (await r.json()) as {
      sourceRevision: {
        id: string;
        repositoryRef: string;
        revisionHash: string;
        branch: string | null;
        shortSha: string | null;
      };
    };
    expect(body.sourceRevision.repositoryRef).toBe("xtrm-dev/mcp-inspector");
    expect(body.sourceRevision.revisionHash).toBe("abc1234def5678900000000000000000000abcde");
    expect(body.sourceRevision.branch).toBe("dev");
    expect(body.sourceRevision.shortSha).toBe("abc1234"); // derived from first 7 chars
  });

  it("rejects a short/missing revision hash — enforces 'never silently substitute main'", async () => {
    for (const body of [
      { repositoryRef: "r", revisionHash: "" },
      { repositoryRef: "r", revisionHash: "short" },
      { repositoryRef: "r" },
      { revisionHash: "abcdefg1234" },
      {},
    ]) {
      const r = await app.request("/api/v1/source/revisions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(r.status).toBe(400);
    }
  });

  it("upsert-by-(repositoryRef, revisionHash): re-posting is idempotent", async () => {
    for (const branch of ["dev", "main", "dev"]) {
      await app.request("/api/v1/source/revisions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          repositoryRef: "same/repo",
          revisionHash: "1234567890abcdef",
          branch,
        }),
      });
    }
    const list = (await (await app.request("/api/v1/source/revisions")).json()) as {
      sourceRevisions: Array<{ branch: string; repositoryRef: string }>;
    };
    expect(list.sourceRevisions).toHaveLength(1);
    expect(list.sourceRevisions[0]?.branch).toBe("dev"); // last write wins on ON CONFLICT DO UPDATE
  });

  it("?repositoryRef=… filters the listing", async () => {
    await app.request("/api/v1/source/revisions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repositoryRef: "repo/a", revisionHash: "aaaaaaaaaaaaaaaa" }),
    });
    await app.request("/api/v1/source/revisions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repositoryRef: "repo/b", revisionHash: "bbbbbbbbbbbbbbbb" }),
    });
    const r = await app.request("/api/v1/source/revisions?repositoryRef=repo/a");
    const body = (await r.json()) as { sourceRevisions: Array<{ repositoryRef: string }> };
    expect(body.sourceRevisions).toHaveLength(1);
    expect(body.sourceRevisions[0]?.repositoryRef).toBe("repo/a");
  });

  it("GET /:id → 404 for unknown", async () => {
    const r = await app.request("/api/v1/source/revisions/nope");
    expect(r.status).toBe(404);
  });

  it("register emits source.revision.registered on the durable event log", async () => {
    await app.request("/api/v1/source/revisions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repositoryRef: "x/y",
        revisionHash: "1234567890abcdef",
      }),
    });
    const events = storage.events.read({ limit: 100 });
    expect(events.some((e) => e.kind === "source.revision.registered")).toBe(true);
  });
});
