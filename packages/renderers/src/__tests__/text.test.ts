import { describe, expect, it } from "vitest";
import { renderText } from "../impl/text";

describe("renderText", () => {
  it("happy path: string input passes through unchanged", () => {
    const r = renderText("hello");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toBe("hello");
  });

  it("happy path: MCP content-block shape concatenates text parts", () => {
    const r = renderText({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toBe("ab");
  });

  it("falls back to JSON.stringify for anything else", () => {
    const r = renderText({ a: 1 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toBe('{"a":1}');
  });

  it("malformed input never throws: circular reference", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const r = renderText(circular);
    expect(r.ok).toBe(false);
  });

  it("empty input", () => {
    const r = renderText("");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toBe("");
  });

  it("big-ish input: 200 text blocks", () => {
    const content = Array.from({ length: 200 }, (_, i) => ({ type: "text", text: `t${i}` }));
    const r = renderText({ content });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toBe(content.map((c) => c.text).join(""));
  });
});
