import { describe, expect, it } from "vitest";
import { renderJsonFormatted } from "../impl/json-formatted";

describe("renderJsonFormatted", () => {
  it("happy path: pretty-prints with 2-space indent", () => {
    const r = renderJsonFormatted({ a: 1, b: [1, 2] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toBe(JSON.stringify({ a: 1, b: [1, 2] }, null, 2));
  });

  it("malformed input never throws: circular reference", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const r = renderJsonFormatted(circular);
    expect(r.ok).toBe(false);
  });

  it("empty input", () => {
    const r = renderJsonFormatted({});
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toBe("{}");
  });

  it("big-ish input: 200 rows", () => {
    const rows = Array.from({ length: 200 }, (_, i) => ({ id: i }));
    const r = renderJsonFormatted(rows);
    expect(r.ok).toBe(true);
    if (r.ok) expect(JSON.parse(r.text)).toHaveLength(200);
  });
});
