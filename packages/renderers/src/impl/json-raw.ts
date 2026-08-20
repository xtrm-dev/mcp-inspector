import type { RenderResult } from "../types";
import { errMsg } from "../shape";

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
