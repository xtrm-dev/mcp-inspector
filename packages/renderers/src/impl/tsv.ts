import type { RenderResult } from "../types";
import { cellToText, deriveColumns, errMsg, isFlatObjectArray, safeSample, toRows } from "../shape";

const KIND = "tsv" as const;

// Tab-delimited; raw tabs/newlines inside a field would break row/column
// alignment so they're backslash-escaped rather than quoted (TSV has no
// standard quoting convention).
export function renderTsv(input: unknown): RenderResult {
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
      columns.map(escapeTsv).join("\t"),
      ...rows.map((row) => row.map((v) => escapeTsv(cellToText(v))).join("\t")),
    ];
    return { ok: true, kind: KIND, text: lines.join("\n"), rows, columns };
  } catch (err) {
    return { ok: false, kind: KIND, reason: errMsg(err) };
  }
}

function escapeTsv(field: string): string {
  return field.replace(/\\/g, "\\\\").replace(/\t/g, "\\t").replace(/\r?\n/g, "\\n");
}
