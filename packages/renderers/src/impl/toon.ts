import type { RenderResult } from "../types";
import { deriveColumns, errMsg, isFlatObjectArray, safeSample, toRows } from "../shape";

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
