import type { RenderPageResult, RenderResult } from "../types";
import { errMsg, pageLines } from "../shape";

const KIND = "json-formatted" as const;

export function renderJsonFormatted(input: unknown): RenderResult {
  try {
    const text = JSON.stringify(input, null, 2);
    if (text === undefined) {
      return { ok: false, kind: KIND, reason: "value is not JSON-serializable (undefined/function/symbol)" };
    }
    return { ok: true, kind: KIND, text };
  } catch (err) {
    return { ok: false, kind: KIND, reason: errMsg(err) };
  }
}

// Line cursor: pages over the pretty-printed JSON's lines.
export function renderJsonFormattedPage(input: unknown, offset: number, limit: number): RenderPageResult {
  const full = renderJsonFormatted(input);
  if (!full.ok) return full;
  const { page, hasMore } = pageLines(full.text, offset, limit);
  return { ok: true, kind: KIND, lines: page, offset, limit, hasMore };
}
