import { describe, expect, it } from "vitest";
import { createRendererRegistry } from "../index";

describe("registry.renderPage", () => {
  const registry = createRendererRegistry();
  const rows = Array.from({ length: 25 }, (_, i) => ({ id: i, name: `row-${i}` }));

  it("pages a row-shaped kind (table) without formatting the rest", () => {
    const page = registry.renderPage(rows, { kind: "table", offset: 10, limit: 5 });
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    expect(page.lines).toHaveLength(5);
    expect(page.rows).toHaveLength(5);
    expect(page.columns).toEqual(["id", "name"]);
    expect(page.offset).toBe(10);
    expect(page.limit).toBe(5);
    expect(page.hasMore).toBe(true);
    expect(page.rows?.[0]).toEqual([10, "row-10"]);
  });

  it("reports hasMore:false on the last page", () => {
    const page = registry.renderPage(rows, { kind: "csv", offset: 20, limit: 10 });
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    expect(page.lines).toHaveLength(5);
    expect(page.hasMore).toBe(false);
  });

  it("pages ndjson by array element", () => {
    const page = registry.renderPage(rows, { kind: "ndjson", offset: 0, limit: 3 });
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    expect(page.lines).toEqual([JSON.stringify(rows[0]), JSON.stringify(rows[1]), JSON.stringify(rows[2])]);
    expect(page.hasMore).toBe(true);
  });

  it("pages a blob kind (json-formatted) by line", () => {
    const page = registry.renderPage({ a: 1, b: [1, 2, 3] }, { kind: "json-formatted", offset: 0, limit: 2 });
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    expect(page.lines.length).toBeLessThanOrEqual(2);
  });

  it("preserves ok:false on malformed input for every row-shaped kind", () => {
    for (const kind of ["table", "csv", "tsv", "toon"] as const) {
      const page = registry.renderPage("not tabular", { kind, offset: 0, limit: 10 });
      expect(page.ok).toBe(false);
    }
  });

  it("renderPage never throws for a kind/input mismatch", () => {
    const page = registry.renderPage(undefined, { kind: "json-formatted", offset: 0, limit: 10 });
    expect(page.ok).toBe(false);
  });
});
