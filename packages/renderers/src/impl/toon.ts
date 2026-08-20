import type { RenderPageResult, RenderResult } from "../types";
import { deriveColumns, errMsg, isFlatObjectArray, pageArray, safeSample, toRows } from "../shape";

const KIND = "toon" as const;

/**
 * TOON (terse object/object notation) — minimal grammar emitted here:
 *
 *   :columns <col1> <col2> ... <colN>
 *   :rows
 *   - <v1> <v2> ... <vN>
 *   - <v1> <v2> ... <vN>
 *
 * Cell encoding:
 *   - null/undefined            -> `~`
 *   - number / boolean          -> bare JSON token (`1`, `true`)
 *   - string, no whitespace and
 *     none of `~"`              -> printed bare
 *   - string otherwise          -> JSON-quoted
 *   - object/array (best effort, TOON is flat) -> JSON-stringified then JSON-quoted
 */
export function renderToon(input: unknown): RenderResult {
  try {
    if (!isFlatObjectArray(input)) {
      const result: RenderResult = {
        ok: false,
        kind: KIND,
        reason: "input is not a non-empty array of flat (scalar-valued) objects",
      };
      const sample = safeSample(input);
      return sample === undefined ? result : { ...result, sample };
    }
    const columns = deriveColumns(input);
    const rows = toRows(input, columns);
    const lines = [`:columns ${columns.join(" ")}`, ":rows", ...rows.map((row) => `- ${row.map(encodeCell).join(" ")}`)];
    return { ok: true, kind: KIND, text: lines.join("\n"), rows, columns };
  } catch (err) {
    return { ok: false, kind: KIND, reason: errMsg(err) };
  }
}

function encodeCell(value: unknown): string {
  if (value === null || value === undefined) return "~";
  if (typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") {
    return value.length === 0 || /[\s~"]/.test(value) ? JSON.stringify(value) : value;
  }
  return JSON.stringify(JSON.stringify(value));
}

// Row cursor: `:columns`/`:rows` header is a stable-across-pages concern
// left to the caller (it's derivable once from the full input); this page
// only emits the `- <row>` lines for [offset, offset+limit).
export function renderToonPage(input: unknown, offset: number, limit: number): RenderPageResult {
  if (!isFlatObjectArray(input)) {
    return { ok: false, kind: KIND, reason: "input is not a non-empty array of flat (scalar-valued) objects" };
  }
  try {
    const columns = deriveColumns(input);
    const { page, hasMore } = pageArray(input, offset, limit);
    const rows = toRows(page, columns);
    const lines = rows.map((row) => `- ${row.map(encodeCell).join(" ")}`);
    return { ok: true, kind: KIND, lines, rows, columns, offset, limit, hasMore };
  } catch (err) {
    return { ok: false, kind: KIND, reason: errMsg(err) };
  }
}
