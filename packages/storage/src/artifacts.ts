import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SqliteDb } from "./database";

export interface ArtifactRecord {
  hash: string;
  size: number;
  mediaType: string | null;
  createdAt: string;
}

export interface ArtifactStoreOptions {
  db: SqliteDb;
  root: string;
}

export interface PutArtifactInput {
  bytes: Uint8Array;
  mediaType?: string;
}

export interface ArtifactStore {
  put(input: PutArtifactInput): ArtifactRecord;
  getBytes(hash: string): Uint8Array;
  getRecord(hash: string): ArtifactRecord | null;
  pathFor(hash: string): string;
}

export function createArtifactStore(options: ArtifactStoreOptions): ArtifactStore {
  const { db, root } = options;
  mkdirSync(root, { recursive: true });

  const insert = db.prepare(
    "INSERT OR IGNORE INTO artifact (hash, size, media_type, created_at) VALUES (?, ?, ?, ?)",
  );
  const get = db.prepare("SELECT hash, size, media_type, created_at FROM artifact WHERE hash = ?");

  function pathFor(hash: string): string {
    if (!/^[0-9a-f]{64}$/.test(hash)) {
      throw new Error(`invalid artifact hash: ${hash}`);
    }
    return join(root, hash.slice(0, 2), hash);
  }

  return {
    pathFor,
    put({ bytes, mediaType }) {
      const hash = createHash("sha256").update(bytes).digest("hex");
      const filePath = pathFor(hash);
      mkdirSync(join(root, hash.slice(0, 2)), { recursive: true });
      if (!existsSync(filePath)) {
        writeFileSync(filePath, bytes);
      }
      const createdAt = new Date().toISOString();
      insert.run(hash, bytes.byteLength, mediaType ?? null, createdAt);
      return getRecordOrThrow(hash);
    },
    getBytes(hash) {
      return readFileSync(pathFor(hash));
    },
    getRecord(hash) {
      const row = get.get(hash) as { hash: string; size: number; media_type: string | null; created_at: string } | undefined;
      if (!row) return null;
      return { hash: row.hash, size: row.size, mediaType: row.media_type, createdAt: row.created_at };
    },
  };

  function getRecordOrThrow(hash: string): ArtifactRecord {
    const row = get.get(hash) as { hash: string; size: number; media_type: string | null; created_at: string } | undefined;
    if (!row) throw new Error(`artifact ${hash} not found after insert`);
    return { hash: row.hash, size: row.size, mediaType: row.media_type, createdAt: row.created_at };
  }
}
