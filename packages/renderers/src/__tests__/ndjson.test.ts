import { describe, expect, it } from "vitest";
import { renderNdjson } from "../impl/ndjson";

describe("renderNdjson", () => {
  it("happy path: array input -> one JSON line per element", () => {
    const r = renderNdjson([{ a: 1 }, { a: 2 }]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toBe('{"a":1}\n{"a":2}');
  });

  it("happy path: object input -> single line", () => {
    const r = renderNdjson({ a: 1 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toBe('{"a":1}');
  });

  it("malformed input never throws: undefined is not JSON-serializable", () => {
    const r = renderNdjson(undefined);
    expect(r.ok).toBe(false);
  });

  it("empty input", () => {
    const r = renderNdjson([]);
    expect(r.ok).toBe(false);
  });

  it("big-ish input: 200 elements", () => {
    const rows = Array.from({ length: 200 }, (_, i) => ({ id: i }));
    const r = renderNdjson(rows);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text.split("\n")).toHaveLength(200);
  });
});
