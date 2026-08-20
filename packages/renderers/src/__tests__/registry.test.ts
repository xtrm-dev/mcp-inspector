import { describe, expect, it } from "vitest";
import { createRendererRegistry, type RendererKind } from "../index";

describe("createRendererRegistry", () => {
  const registry = createRendererRegistry();

  it("available() lists every renderer kind", () => {
    const kinds = registry.available();
    const expected: RendererKind[] = [
      "json-tree",
      "json-formatted",
      "json-raw",
      "table",
      "toon",
      "csv",
      "tsv",
      "ndjson",
      "text",
      "mcp-content-block",
    ];
    expect(kinds.sort()).toEqual(expected.sort());
  });

  it("describe() returns metadata for each kind", () => {
    for (const kind of registry.available()) {
      const meta = registry.describe(kind);
      expect(meta.kind).toBe(kind);
      expect(meta.label).toBeTruthy();
      expect(typeof meta.supportsShape).toBe("function");
    }
  });

  it("render() dispatches to the matching implementation", () => {
    const r = registry.render({ a: 1 }, { kind: "json-formatted" });
    expect(r.ok).toBe(true);
    expect(r.kind).toBe("json-formatted");
  });

  it("render() never throws even for a kind/input mismatch", () => {
    const r = registry.render("not tabular", { kind: "table" });
    expect(r.ok).toBe(false);
  });

  it("renderer failure never affects a caller that falls through to json-formatted", () => {
    const failed = registry.render("nope", { kind: "table" });
    expect(failed.ok).toBe(false);
    const fallback = registry.render("nope", { kind: "json-formatted" });
    expect(fallback.ok).toBe(true);
  });
});
