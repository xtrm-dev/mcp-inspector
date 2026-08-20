import type { RenderResult } from "../types";
import { errMsg } from "../shape";

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
