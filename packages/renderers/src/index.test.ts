import { describe, expect, it } from "vitest";
import { classifyResult } from "./index";

describe("result classification", () => {
  it("prefers a table for arrays of records", () => {
    expect(classifyResult([{ a: 1 }, { a: 2 }])).toMatchObject({ renderer: "table", tabular: true });
  });

  it("keeps TOON as an explicit renderer choice", () => {
    expect(classifyResult("a|b\n1|2", "TOON").renderer).toBe("toon");
  });

  it("accepts scalar structuredContent", () => {
    expect(classifyResult(true).renderer).toBe("structured");
  });
});
