import type { RenderResult } from "../types";
import { errMsg, isPlainObject } from "../shape";

const KIND = "json-tree" as const;

// Fold-point threshold: an object/array nested below the root (depth > 0)
// with more than this many entries gets a `▸ … N keys/items` marker before
// its expansion. The string is still fully expanded — folding on the marker
// is a UI-side concern (Phase F slice 2); this renderer just emits the hint.
const FOLD_THRESHOLD = 3;

export function renderJsonTree(input: unknown): RenderResult {
  try {
    const text = printNode(input, 0, "");
    return { ok: true, kind: KIND, text };
  } catch (err) {
    return { ok: false, kind: KIND, reason: errMsg(err) };
  }
}

function printNode(value: unknown, depth: number, indent: string): string {
  const childIndent = `${indent}  `;
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const marker = depth > 0 && value.length > FOLD_THRESHOLD ? ` ▸ … ${value.length} items` : "";
    const body = value.map((v) => `${childIndent}${printNode(v, depth + 1, childIndent)}`).join(",\n");
    return `[${marker}\n${body}\n${indent}]`;
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (keys.length === 0) return "{}";
    const marker = depth > 0 && keys.length > FOLD_THRESHOLD ? ` ▸ … ${keys.length} keys` : "";
    const body = keys
      .map((k) => `${childIndent}${JSON.stringify(k)}: ${printNode(value[k], depth + 1, childIndent)}`)
      .join(",\n");
    return `{${marker}\n${body}\n${indent}}`;
  }
  const text = JSON.stringify(value);
  return text === undefined ? "null" : text;
}
