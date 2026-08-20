// Shape-detection + small utilities shared by the renderer implementations
// and the registry's suggest() heuristic. Intentionally dependency-free.

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFlatValue(value: unknown): boolean {
  return value === null || typeof value !== "object";
}

/** Array of non-empty, non-array objects whose own values are all scalars. */
export function isFlatObjectArray(value: unknown): value is Array<Record<string, unknown>> {
  if (!Array.isArray(value) || value.length === 0) return false;
  return value.every((item) => isPlainObject(item) && Object.values(item).every(isFlatValue));
}

/** MCP tool/resource result wrapper: `{ content: [...] }`. */
export function isMcpContentBlockShape(value: unknown): value is { content: unknown[] } {
  return isPlainObject(value) && Array.isArray(value.content);
}

export function isJsonPrimitive(value: unknown): value is string | number | boolean | null {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

/** First-seen-order union of keys across a row set. */
export function deriveColumns(rows: Array<Record<string, unknown>>): string[] {
  const columns: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        columns.push(key);
      }
    }
  }
  return columns;
}

export function toRows(input: Array<Record<string, unknown>>, columns: string[]): unknown[][] {
  return input.map((row) => columns.map((col) => (col in row ? row[col] : null)));
}

export function cellToText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Best-effort truncated JSON preview for ok:false diagnostics. Never throws. */
export function safeSample(input: unknown, maxLen = 200): string | undefined {
  try {
    const text = JSON.stringify(input);
    if (text === undefined) return undefined;
    return text.length > maxLen ? `${text.slice(0, maxLen)}…` : text;
  } catch {
    return undefined;
  }
}

// ---- Paged rendering helpers (Phase F slice 2) ----

/** Slice [offset, offset+limit) out of an already in-memory array + hasMore lookahead. */
export function pageArray<T>(arr: readonly T[], offset: number, limit: number): { page: T[]; hasMore: boolean } {
  const safeOffset = Math.max(0, offset);
  const safeLimit = Math.max(0, limit);
  const page = arr.slice(safeOffset, safeOffset + safeLimit);
  return { page, hasMore: safeOffset + page.length < arr.length };
}

/** Same as pageArray but over a text blob's "\n"-delimited lines. */
export function pageLines(text: string, offset: number, limit: number): { page: string[]; hasMore: boolean } {
  const lines = text.length === 0 ? [] : text.split("\n");
  return pageArray(lines, offset, limit);
}
