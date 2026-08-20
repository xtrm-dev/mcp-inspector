import type { RenderPageResult, RenderResult } from "../types";
import { cellToText, deriveColumns, errMsg, isFlatObjectArray, pageArray, safeSample, toRows } from "../shape";

const KIND = "csv" as const;

// RFC 4180 minimal: quote a field if it contains a comma, quote, or newline;
// embedded quotes are doubled.
export function renderCsv(input: unknown): RenderResult {
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
    const lines = [
      columns.map(quoteCsv).join(","),
      ...rows.map((row) => row.map((v) => quoteCsv(cellToText(v))).join(",")),
    ];
    return { ok: true, kind: KIND, text: lines.join("\n"), rows, columns };
  } catch (err) {
    return { ok: false, kind: KIND, reason: errMsg(err) };
  }
}

function quoteCsv(field: string): string {
  return /[",\n\r]/.test(field) ? `"${field.replace(/"/g, '""')}"` : field;
}

// Row cursor: columns are derived from the full input (cheap key scan) so
// they stay stable across pages; only the requested row window is formatted.
export function renderCsvPage(input: unknown, offset: number, limit: number): RenderPageResult {
  if (!isFlatObjectArray(input)) {
    return { ok: false, kind: KIND, reason: "input is not a non-empty array of flat (scalar-valued) objects" };
  }
  try {
    const columns = deriveColumns(input);
    const { page, hasMore } = pageArray(input, offset, limit);
    const rows = toRows(page, columns);
    const lines = rows.map((row) => row.map((v) => quoteCsv(cellToText(v))).join(","));
    return { ok: true, kind: KIND, lines, rows, columns, offset, limit, hasMore };
  } catch (err) {
    return { ok: false, kind: KIND, reason: errMsg(err) };
  }
}
