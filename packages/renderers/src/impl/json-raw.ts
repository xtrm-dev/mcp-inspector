import type { RenderPageResult, RenderResult } from "../types";
import { errMsg, pageLines } from "../shape";

const KIND = "json-raw" as const;

export function renderJsonRaw(input: unknown): RenderResult {
  try {
    const text = JSON.stringify(input);
    if (text === undefined) {
      return { ok: false, kind: KIND, reason: "value is not JSON-serializable (undefined/function/symbol)" };
    }
    return { ok: true, kind: KIND, text };
  } catch (err) {
    return { ok: false, kind: KIND, reason: errMsg(err) };
  }
}

// Line cursor: json-raw is a single unbroken line (no "\n"), so a page is
// either that whole line (offset 0) or empty (offset > 0).
export function renderJsonRawPage(input: unknown, offset: number, limit: number): RenderPageResult {
  const full = renderJsonRaw(input);
  if (!full.ok) return full;
  const { page, hasMore } = pageLines(full.text, offset, limit);
  return { ok: true, kind: KIND, lines: page, offset, limit, hasMore };
}
