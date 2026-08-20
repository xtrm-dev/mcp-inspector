import type { RenderPageResult, RenderResult } from "../types";
import { cellToText, deriveColumns, errMsg, isFlatObjectArray, pageArray, safeSample, toRows } from "../shape";

const KIND = "table" as const;

export function renderTable(input: unknown): RenderResult {
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
    const text = toMarkdownTable(columns, rows);
    return { ok: true, kind: KIND, text, rows, columns };
  } catch (err) {
    return { ok: false, kind: KIND, reason: errMsg(err) };
  }
}

function toMarkdownTable(columns: string[], rows: unknown[][]): string {
  const header = `| ${columns.join(" | ")} |`;
  const sep = `| ${columns.map(() => "---").join(" | ")} |`;
  const body = rows.map((row) => `| ${row.map((v) => cellToText(v).replace(/\|/g, "\\|")).join(" | ")} |`).join("\n");
  return [header, sep, body].join("\n");
}

// Row cursor: markdown header/separator lines are not repeated per page —
// this emits one `| ... |` line per row in [offset, offset+limit).
export function renderTablePage(input: unknown, offset: number, limit: number): RenderPageResult {
  if (!isFlatObjectArray(input)) {
    return { ok: false, kind: KIND, reason: "input is not a non-empty array of flat (scalar-valued) objects" };
  }
  try {
    const columns = deriveColumns(input);
    const { page, hasMore } = pageArray(input, offset, limit);
    const rows = toRows(page, columns);
    const lines = rows.map((row) => `| ${row.map((v) => cellToText(v).replace(/\|/g, "\\|")).join(" | ")} |`);
    return { ok: true, kind: KIND, lines, rows, columns, offset, limit, hasMore };
  } catch (err) {
    return { ok: false, kind: KIND, reason: errMsg(err) };
  }
}
