import { describe, expect, it } from "vitest";
import { renderTable } from "../impl/table";

describe("renderTable", () => {
  it("happy path: derives column union in first-seen order", () => {
    const r = renderTable([{ a: 1, b: 2 }, { b: 3, c: 4 }]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.columns).toEqual(["a", "b", "c"]);
      expect(r.rows).toEqual([[1, 2, null], [null, 3, 4]]);
      expect(r.text).toContain("| a | b | c |");
    }
  });

  it("malformed input never throws: not an array of flat objects", () => {
    const r = renderTable([{ a: { nested: true } }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBeTruthy();
  });

  it("malformed input never throws: not an array at all", () => {
    const r = renderTable("not an array");
    expect(r.ok).toBe(false);
  });

  it("empty input", () => {
    const r = renderTable([]);
    expect(r.ok).toBe(false);
  });

  it("big-ish input: 200 rows", () => {
    const rows = Array.from({ length: 200 }, (_, i) => ({ id: i, name: `row-${i}` }));
    const r = renderTable(rows);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.rows).toHaveLength(200);
      expect(r.columns).toEqual(["id", "name"]);
    }
  });
});
