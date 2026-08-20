export type RendererKind =
  | "json-tree"
  | "json-formatted"
  | "json-raw"
  | "table"
  | "toon"
  | "csv"
  | "tsv"
  | "ndjson"
  | "text"
  | "mcp-content-block";

export interface RendererMeta {
  kind: RendererKind;
  label: string;
  mimeHint?: string;
  /** Fast heuristic — not a guarantee that render() will succeed. */
  supportsShape: (input: unknown) => boolean;
}

export type RenderResult =
  | { ok: true; kind: RendererKind; text: string; rows?: unknown[][]; columns?: string[] }
  | { ok: false; kind: RendererKind; reason: string; sample?: string };

export type RenderFn = (input: unknown) => RenderResult;

// ---- Paged rendering (Phase F slice 2 — large payloads) ----

export interface RenderPageMeta {
  offset: number;
  limit: number;
  hasMore: boolean;
}

/**
 * A bounded window of a render: `lines` are the formatted rows/lines for
 * [offset, offset + lines.length). Row-shaped kinds (table/csv/tsv/toon/
 * ndjson) additionally carry `rows`/`columns` cursors; blob kinds (json-*,
 * text, mcp-content-block) only have `lines`.
 */
export type RenderPageResult =
  | ({ ok: true; kind: RendererKind; lines: string[]; rows?: unknown[][]; columns?: string[] } & RenderPageMeta)
  | { ok: false; kind: RendererKind; reason: string };

export type RenderPageFn = (input: unknown, offset: number, limit: number) => RenderPageResult;
