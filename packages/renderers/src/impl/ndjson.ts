import type { RenderPageResult, RenderResult } from "../types";
import { errMsg, pageArray } from "../shape";

const KIND = "ndjson" as const;

export function renderNdjson(input: unknown): RenderResult {
  try {
    if (Array.isArray(input)) {
      if (input.length === 0) {
        return { ok: false, kind: KIND, reason: "empty array" };
      }
      const lines = input.map((item) => {
        const line = JSON.stringify(item);
        if (line === undefined) throw new Error("array element is not JSON-serializable");
        return line;
      });
      return { ok: true, kind: KIND, text: lines.join("\n") };
    }
    const line = JSON.stringify(input);
    if (line === undefined) {
      return { ok: false, kind: KIND, reason: "value is not JSON-serializable (undefined/function/symbol)" };
    }
    return { ok: true, kind: KIND, text: line };
  } catch (err) {
    return { ok: false, kind: KIND, reason: errMsg(err) };
  }
}

// Row cursor: each array element is one line; a bare scalar/object is
// treated as a single-element array (offset 0, limit >= 1).
export function renderNdjsonPage(input: unknown, offset: number, limit: number): RenderPageResult {
  const arr = Array.isArray(input) ? input : [input];
  if (arr.length === 0) {
    return { ok: false, kind: KIND, reason: "empty array" };
  }
  try {
    const { page, hasMore } = pageArray(arr, offset, limit);
    const lines = page.map((item) => {
      const line = JSON.stringify(item);
      if (line === undefined) throw new Error("array element is not JSON-serializable");
      return line;
    });
    return { ok: true, kind: KIND, lines, offset, limit, hasMore };
  } catch (err) {
    return { ok: false, kind: KIND, reason: errMsg(err) };
  }
}
