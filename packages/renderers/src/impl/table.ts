import type { RenderResult } from "../types";
import { cellToText, deriveColumns, errMsg, isFlatObjectArray, safeSample, toRows } from "../shape";

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
