import { describe, expect, it } from "vitest";
import { renderJsonRaw } from "../impl/json-raw";

describe("renderJsonRaw", () => {
  it("happy path: compact JSON, no whitespace", () => {
    const r = renderJsonRaw({ a: 1 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toBe('{"a":1}');
  });

  it("malformed input never throws: circular reference", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const r = renderJsonRaw(circular);
    expect(r.ok).toBe(false);
  });

  it("empty input", () => {
    const r = renderJsonRaw([]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toBe("[]");
  });

  it("big-ish input: 200 rows", () => {
    const rows = Array.from({ length: 200 }, (_, i) => ({ id: i }));
    const r = renderJsonRaw(rows);
    expect(r.ok).toBe(true);
    if (r.ok) expect(JSON.parse(r.text)).toHaveLength(200);
  });
});
