import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
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

export interface ArtifactPage {
  lines: string[];
  offset: number;
  limit: number;
  hasMore: boolean;
}

export interface ArtifactStore {
  put(input: PutArtifactInput): ArtifactRecord;
  getBytes(hash: string): Uint8Array;
  getRecord(hash: string): ArtifactRecord | null;
  pathFor(hash: string): string;
  /**
   * Bounded-memory line-windowed read of a "\n"-delimited artifact: streams
   * the file and stops as soon as [offset, offset + limit) (plus one
   * lookahead line for hasMore) has been seen. Never buffers the whole file
   * — safe for artifacts far larger than available memory.
   */
  getPage(hash: string, offset: number, limit: number): Promise<ArtifactPage>;
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
    getPage(hash, offset, limit) {
      return readArtifactPage(pathFor(hash), offset, limit);
    },
  };

  function getRecordOrThrow(hash: string): ArtifactRecord {
    const row = get.get(hash) as { hash: string; size: number; media_type: string | null; created_at: string } | undefined;
    if (!row) throw new Error(`artifact ${hash} not found after insert`);
    return { hash: row.hash, size: row.size, mediaType: row.media_type, createdAt: row.created_at };
  }
}

/**
 * Streams `filePath` line-by-line and collects at most `limit + 1` lines
 * starting at `offset` (the +1 is a lookahead used only to compute
 * `hasMore`, then discarded) — the stream is destroyed as soon as that
 * many lines have been seen, so nothing past the requested window is ever
 * read into memory.
 */
function readArtifactPage(filePath: string, offset: number, limit: number): Promise<ArtifactPage> {
  const safeOffset = Math.max(0, offset);
  const safeLimit = Math.max(0, limit);
  return new Promise((resolve, reject) => {
    const stream = createReadStream(filePath, { encoding: "utf8" });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    const collected: string[] = [];
    let seen = 0;
    let settled = false;

    function finish(lines: string[]): void {
      if (settled) return;
      settled = true;
      rl.close();
      stream.destroy();
      const hasMore = lines.length > safeLimit;
      resolve({ lines: hasMore ? lines.slice(0, safeLimit) : lines, offset: safeOffset, limit: safeLimit, hasMore });
    }

    rl.on("line", (line) => {
      if (seen >= safeOffset && collected.length <= safeLimit) {
        collected.push(line);
      }
      seen += 1;
      if (collected.length > safeLimit) {
        finish(collected);
      }
    });
    rl.on("close", () => finish(collected));
    stream.on("error", (err) => {
      if (settled) return;
      settled = true;
      rl.close();
      reject(err);
    });
  });
}
