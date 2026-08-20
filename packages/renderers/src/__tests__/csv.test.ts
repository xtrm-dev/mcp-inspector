import { describe, expect, it } from "vitest";
import { renderCsv } from "../impl/csv";

describe("renderCsv", () => {
  it("happy path: header row + data rows, comma-joined", () => {
    const r = renderCsv([{ a: 1, b: "x" }, { a: 2, b: "y" }]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toBe("a,b\n1,x\n2,y");
  });

  it("quotes fields containing a comma, quote, or newline; doubles embedded quotes", () => {
    const r = renderCsv([{ a: 'has,comma', b: 'has "quote"', c: "line\nbreak" }]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toBe('a,b,c\n"has,comma","has ""quote""","line\nbreak"');
  });

  it("malformed input never throws", () => {
    const r = renderCsv({ not: "an array" });
    expect(r.ok).toBe(false);
  });

  it("empty input", () => {
    const r = renderCsv([]);
    expect(r.ok).toBe(false);
  });

  it("big-ish input: 200 rows", () => {
    const rows = Array.from({ length: 200 }, (_, i) => ({ id: i }));
    const r = renderCsv(rows);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text.split("\n")).toHaveLength(201);
  });
});
