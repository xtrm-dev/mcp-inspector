import type { RenderResult } from "../types";
import { errMsg, isMcpContentBlockShape, isPlainObject } from "../shape";

const KIND = "mcp-content-block" as const;

// Normalizes `{ content: ContentBlock[] }` (the shape of an MCP tool/resource
// result) into `{ blocks: [...] }`. Blocks are passed through as-is — media
// (image/audio) rendering is out of scope for this slice; the block still
// shows up in the list with its declared `type`.
export function renderMcpContentBlock(input: unknown): RenderResult {
  try {
    if (!isMcpContentBlockShape(input)) {
      return { ok: false, kind: KIND, reason: "input is not an MCP content-block wrapper ({ content: [...] })" };
    }
    if (input.content.length === 0) {
      return { ok: false, kind: KIND, reason: "empty content array" };
    }
    const blocks: Array<Record<string, unknown>> = [];
    for (const block of input.content) {
      if (!isPlainObject(block) || typeof block.type !== "string") {
        return { ok: false, kind: KIND, reason: "content array contains a malformed block (missing 'type')" };
      }
      blocks.push(block);
    }
    const text = JSON.stringify({ blocks }, null, 2);
    if (text === undefined) {
      return { ok: false, kind: KIND, reason: "content blocks are not JSON-serializable" };
    }
    return { ok: true, kind: KIND, text };
  } catch (err) {
    return { ok: false, kind: KIND, reason: errMsg(err) };
  }
}
