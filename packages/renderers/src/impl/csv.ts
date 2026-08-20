import type { RenderResult } from "../types";
import { cellToText, deriveColumns, errMsg, isFlatObjectArray, safeSample, toRows } from "../shape";

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
