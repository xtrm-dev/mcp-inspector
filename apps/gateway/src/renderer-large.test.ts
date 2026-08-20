import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSdkAdapter } from "@mcp-inspector-x/protocol";
import { openStorage, type Storage } from "@mcp-inspector-x/storage";
import { buildRenderSurface, buildGatewayApp } from "./routes";
import { createServerManager, type ServerManager } from "./servers";
import { createSecretsRegistry, type SecretsRegistry } from "./secrets";

// These tests exercise the Phase F slice 2 large-payload path
// (RENDER_INLINE_MAX_BYTES spill + GET /api/v1/artifacts/:sha/page) without
// a live MCP round trip — buildRenderSurface() is the exact function the
// tool-call/resource-read handlers call, so unit-testing it directly covers
// the spill decision; the HTTP-level tests below cover the page endpoint
// against artifacts seeded the same way buildRenderSurface() would seed them.

describe("large-payload rendering (Phase F slice 2)", () => {
  let storage: Storage;
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "mix-renderer-large-"));
    storage = openStorage({ dataDir });
  });

  afterEach(() => {
    storage.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  describe("buildRenderSurface", () => {
    it("keeps a small result inline (no spill)", () => {
      const value = { a: 1, b: [1, 2, 3] };
      const surface = buildRenderSurface(value, storage.artifacts);
      expect(surface.spilled).toBe(false);
      if (surface.spilled) throw new Error("unreachable");
      expect(surface.value).toEqual(value);
    });

    it("spills a >64KiB array result and returns an artifactRef + preview", () => {
      // ~200 KiB of rows.
      const rows = Array.from({ length: 4000 }, (_, i) => ({ id: i, name: `row-${i}`, note: "x".repeat(40) }));
      expect(Buffer.byteLength(JSON.stringify(rows))).toBeGreaterThan(200 * 1024);

      const surface = buildRenderSurface(rows, storage.artifacts);
      expect(surface.spilled).toBe(true);
      if (!surface.spilled) throw new Error("unreachable");
      expect(surface.artifactRef).toMatch(/^[0-9a-f]{64}$/);
      expect(surface.preview.ok).toBe(true);
      if (!surface.preview.ok) throw new Error("unreachable");
      expect(surface.preview.lines.length).toBe(20); // RENDER_PREVIEW_LIMIT
      expect(surface.preview.offset).toBe(0);
      expect(surface.preview.hasMore).toBe(true);

      const record = storage.artifacts.getRecord(surface.artifactRef);
      expect(record?.mediaType).toBe("application/x-ndjson");
    });

    it("respects RENDER_INLINE_MAX_BYTES overridden via env", () => {
      const prev = process.env.RENDER_INLINE_MAX_BYTES;
      process.env.RENDER_INLINE_MAX_BYTES = "10"; // ridiculously small — everything spills
      try {
        const surface = buildRenderSurface({ tiny: true }, storage.artifacts);
        expect(surface.spilled).toBe(true);
      } finally {
        if (prev === undefined) delete process.env.RENDER_INLINE_MAX_BYTES;
        else process.env.RENDER_INLINE_MAX_BYTES = prev;
      }
    });
  });

  describe("GET /api/v1/artifacts/:sha/page", () => {
    let adapter: ReturnType<typeof createSdkAdapter>;
    let serverManager: ServerManager;
    let secrets: SecretsRegistry;
    let app: ReturnType<typeof buildGatewayApp>;

    beforeAll(() => {
      adapter = createSdkAdapter();
    });

    beforeEach(() => {
      secrets = createSecretsRegistry({ storage });
      serverManager = createServerManager({ storage, adapter, secrets });
      app = buildGatewayApp({ adapter, storage, serverManager, secrets });
    });

    afterAll(async () => {
      await adapter?.disconnect("noop").catch(() => {});
    });

    it("returns a bounded page and walks through hasMore to the end", async () => {
      const rows = Array.from({ length: 4000 }, (_, i) => ({ id: i, name: `row-${i}`, note: "x".repeat(40) }));
      const surface = buildRenderSurface(rows, storage.artifacts);
      if (!surface.spilled) throw new Error("expected spill");

      const r1 = await app.request(
        `/api/v1/artifacts/${surface.artifactRef}/page?offset=0&limit=50&kind=table`,
      );
      expect(r1.status).toBe(200);
      const p1 = (await r1.json()) as {
        artifactRef: string;
        offset: number;
        limit: number;
        hasMore: boolean;
        lines: string[];
        rows?: unknown[][];
        columns?: string[];
      };
      expect(p1.offset).toBe(0);
      expect(p1.limit).toBe(50);
      expect(p1.hasMore).toBe(true);
      expect(p1.lines).toHaveLength(50);
      expect(p1.rows).toHaveLength(50);
      expect(p1.columns).toEqual(["id", "name", "note"]);
      expect(p1.rows?.[0]).toEqual([0, "row-0", "x".repeat(40)]);

      const rLast = await app.request(
        `/api/v1/artifacts/${surface.artifactRef}/page?offset=3990&limit=50`,
      );
      const pLast = (await rLast.json()) as { hasMore: boolean; lines: string[] };
      expect(pLast.hasMore).toBe(false);
      expect(pLast.lines).toHaveLength(10);
    });

    it("defaults offset/limit when the query string omits them", async () => {
      const rows = Array.from({ length: 20 }, (_, i) => ({ id: i }));
      const bytes = new TextEncoder().encode(rows.map((r) => JSON.stringify(r)).join("\n"));
      const rec = storage.artifacts.put({ bytes, mediaType: "application/x-ndjson" });

      const r = await app.request(`/api/v1/artifacts/${rec.hash}/page`);
      const body = (await r.json()) as { offset: number; limit: number; lines: string[] };
      expect(body.offset).toBe(0);
      expect(body.limit).toBe(50);
      expect(body.lines).toHaveLength(20);
    });

    it("404s for an unknown artifact hash", async () => {
      const r = await app.request(`/api/v1/artifacts/${"0".repeat(64)}/page`);
      expect(r.status).toBe(404);
    });
  });
});
