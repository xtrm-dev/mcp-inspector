import type { JsonValue, RendererKind } from "../api/types";

export const ALL_RENDERER_KINDS: RendererKind[] = [
  "json-tree",
  "json-formatted",
  "json-raw",
  "table",
  "toon",
  "csv",
  "tsv",
  "ndjson",
  "text",
  "mcp-content-block",
];

function isFlatObjectArray(value: unknown): value is Array<Record<string, JsonValue>> {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((row) => typeof row === "object" && row !== null && !Array.isArray(row))
  );
}

function delimited(rows: Array<Record<string, JsonValue>>, sep: string): string {
  const columns = Array.from(rows.reduce((set, row) => { Object.keys(row).forEach((k) => set.add(k)); return set; }, new Set<string>()));
  const lines = [columns.join(sep)];
  for (const row of rows) {
    lines.push(columns.map((c) => stringifyCell(row[c])).join(sep));
  }
  return lines.join("\n");
}

function stringifyCell(value: JsonValue | undefined): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * Client-side rendering for a small, already-in-memory value. This is a
 * lightweight presentation layer, not a re-implementation of the server's
 * renderer registry (packages/renderers gains that richer registry in a
 * parallel PR not yet in this branch's base) — for large/paged payloads the
 * server pre-renders via GET /api/v1/artifacts/:sha/page?kind=, see
 * RendererView's paged path.
 */
export function renderInline(value: JsonValue, kind: RendererKind): string {
  switch (kind) {
    case "json-formatted":
    case "json-tree":
      return JSON.stringify(value, null, 2);
    case "json-raw":
      return JSON.stringify(value);
    case "table":
    case "csv":
      return isFlatObjectArray(value) ? delimited(value, ",") : JSON.stringify(value, null, 2);
    case "tsv":
      return isFlatObjectArray(value) ? delimited(value, "\t") : JSON.stringify(value, null, 2);
    case "ndjson":
      return Array.isArray(value) ? value.map((v) => JSON.stringify(v)).join("\n") : JSON.stringify(value);
    case "text":
      return typeof value === "string" ? value : JSON.stringify(value, null, 2);
    case "toon":
    case "mcp-content-block":
    default:
      return JSON.stringify(value, null, 2);
  }
}

export function suggestKindClientSide(value: JsonValue): RendererKind {
  if (isFlatObjectArray(value)) return "table";
  if (typeof value === "object" && value !== null) return "json-tree";
  return "text";
}
