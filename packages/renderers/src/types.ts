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
