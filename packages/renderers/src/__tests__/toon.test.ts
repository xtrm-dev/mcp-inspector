import { describe, expect, it } from "vitest";
import { renderToon } from "../impl/toon";

describe("renderToon", () => {
  it("happy path: header + row lines, quoting strings with spaces, ~ for null", () => {
    const r = renderToon([{ a: 1, b: "hello world", c: true, d: null }]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.text).toContain(":columns a b c d");
      expect(r.text).toContain(":rows");
      expect(r.text).toContain('- 1 "hello world" true ~');
    }
  });

  it("bare strings without whitespace are not quoted", () => {
    const r = renderToon([{ a: "hello" }]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toContain("- hello");
  });

  it("malformed input never throws", () => {
    const r = renderToon(42);
    expect(r.ok).toBe(false);
  });

  it("empty input", () => {
    const r = renderToon([]);
    expect(r.ok).toBe(false);
  });

  it("big-ish input: 200 rows", () => {
    const rows = Array.from({ length: 200 }, (_, i) => ({ id: i }));
    const r = renderToon(rows);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.rows).toHaveLength(200);
  });
});
