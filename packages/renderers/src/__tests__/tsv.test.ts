import { describe, expect, it } from "vitest";
import { renderTsv } from "../impl/tsv";

describe("renderTsv", () => {
  it("happy path: header row + data rows, tab-joined", () => {
    const r = renderTsv([{ a: 1, b: "x" }, { a: 2, b: "y" }]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toBe("a\tb\n1\tx\n2\ty");
  });

  it("escapes raw tabs and newlines instead of quoting", () => {
    const r = renderTsv([{ a: "has\ttab", b: "has\nnewline" }]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toBe("a\tb\nhas\\ttab\thas\\nnewline");
  });

  it("malformed input never throws", () => {
    const r = renderTsv(null);
    expect(r.ok).toBe(false);
  });

  it("empty input", () => {
    const r = renderTsv([]);
    expect(r.ok).toBe(false);
  });

  it("big-ish input: 200 rows", () => {
    const rows = Array.from({ length: 200 }, (_, i) => ({ id: i }));
    const r = renderTsv(rows);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text.split("\n")).toHaveLength(201);
  });
});
