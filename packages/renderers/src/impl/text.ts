import type { RenderResult } from "../types";
import { errMsg, isMcpContentBlockShape, isPlainObject } from "../shape";

const KIND = "text" as const;

export function renderText(input: unknown): RenderResult {
  try {
    if (typeof input === "string") {
      return { ok: true, kind: KIND, text: input };
    }
    if (isMcpContentBlockShape(input)) {
      const parts: string[] = [];
      for (const block of input.content) {
        if (isPlainObject(block) && block.type === "text" && typeof block.text === "string") {
          parts.push(block.text);
        }
      }
      return { ok: true, kind: KIND, text: parts.join("") };
    }
    const text = JSON.stringify(input);
    if (text === undefined) {
      return { ok: false, kind: KIND, reason: "value is not representable as text" };
    }
    return { ok: true, kind: KIND, text };
  } catch (err) {
    return { ok: false, kind: KIND, reason: errMsg(err) };
  }
}
