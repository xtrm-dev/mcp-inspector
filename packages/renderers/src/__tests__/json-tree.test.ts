import { describe, expect, it } from "vitest";
import { renderJsonTree } from "../impl/json-tree";

describe("renderJsonTree", () => {
  it("happy path: expands nested structure and adds fold markers past the threshold", () => {
    const r = renderJsonTree({ nested: { a: 1, b: 2, c: 3, d: 4, e: 5 } });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.text).toContain("▸ … 5 keys");
      expect(r.text).toContain('"a": 1');
    }
  });

  it("does not mark the root even when it has many keys", () => {
    const r = renderJsonTree({ a: 1, b: 2, c: 3, d: 4 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text.startsWith("{\n")).toBe(true);
  });

  it("malformed input never throws: circular reference", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const r = renderJsonTree(circular);
    expect(r.ok).toBe(false);
  });

  it("empty input", () => {
    const r = renderJsonTree({});
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toBe("{}");
  });

  it("big-ish input: 200-element array gets a fold marker", () => {
    const rows = Array.from({ length: 200 }, (_, i) => i);
    const r = renderJsonTree({ rows });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toContain("▸ … 200 items");
  });
});
