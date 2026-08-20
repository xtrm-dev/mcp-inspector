import { describe, expect, it } from "vitest";
import { createRendererRegistry } from "../index";

describe("registry.suggest", () => {
  const registry = createRendererRegistry();

  it("array of flat objects -> table", () => {
    expect(registry.suggest([{ a: 1 }, { a: 2 }])).toBe("table");
  });

  it("large array of primitives -> ndjson", () => {
    const arr = Array.from({ length: 50 }, (_, i) => i);
    expect(registry.suggest(arr)).toBe("ndjson");
  });

  it("small array of primitives -> json-tree (below the ndjson threshold)", () => {
    expect(registry.suggest([1, 2, 3])).toBe("json-tree");
  });

  it("MCP content-block wrapper -> mcp-content-block", () => {
    expect(registry.suggest({ content: [{ type: "text", text: "hi" }] })).toBe("mcp-content-block");
  });

  it("everything else -> json-tree", () => {
    expect(registry.suggest({ a: 1, b: 2 })).toBe("json-tree");
    expect(registry.suggest("just a string")).toBe("json-tree");
    expect(registry.suggest(42)).toBe("json-tree");
  });
});
