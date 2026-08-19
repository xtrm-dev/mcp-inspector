import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, applyMigrations } from "./database";
import { createArtifactStore } from "./artifacts";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "mix-artifacts-"));
}

describe("artifact store", () => {
  it("puts bytes at content-addressed path and returns record", () => {
    const dir = tempRoot();
    try {
      const db = openDatabase({ path: ":memory:" });
      applyMigrations(db);
      const store = createArtifactStore({ db, root: join(dir, "artifacts") });
      const bytes = new TextEncoder().encode("hello world");
      const rec = store.put({ bytes, mediaType: "text/plain" });
      expect(rec.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(rec.size).toBe(bytes.byteLength);
      expect(rec.mediaType).toBe("text/plain");
      const p = store.pathFor(rec.hash);
      const stat = statSync(p);
      expect(stat.size).toBe(bytes.byteLength);
      const read = store.getBytes(rec.hash);
      expect(new TextDecoder().decode(read)).toBe("hello world");
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("deduplicates by hash (same bytes twice → one artifact row + one file)", () => {
    const dir = tempRoot();
    try {
      const db = openDatabase({ path: ":memory:" });
      applyMigrations(db);
      const store = createArtifactStore({ db, root: join(dir, "artifacts") });
      const bytes = new TextEncoder().encode("dedup me");
      const a = store.put({ bytes });
      const b = store.put({ bytes });
      expect(a.hash).toBe(b.hash);
      const count = (db.prepare("SELECT COUNT(*) AS n FROM artifact").get() as { n: number }).n;
      expect(count).toBe(1);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects malformed hashes on lookup", () => {
    const dir = tempRoot();
    try {
      const db = openDatabase({ path: ":memory:" });
      applyMigrations(db);
      const store = createArtifactStore({ db, root: join(dir, "artifacts") });
      expect(() => store.pathFor("not-a-hash")).toThrow(/invalid artifact hash/);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
