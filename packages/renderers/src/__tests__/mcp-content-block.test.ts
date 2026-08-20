import { describe, expect, it } from "vitest";
import { renderMcpContentBlock } from "../impl/mcp-content-block";

describe("renderMcpContentBlock", () => {
  it("happy path: normalizes content array into { blocks }", () => {
    const r = renderMcpContentBlock({ content: [{ type: "text", text: "hi" }] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(JSON.parse(r.text)).toEqual({ blocks: [{ type: "text", text: "hi" }] });
  });

  it("passes through non-text block types (image/audio/resource/resource_link) as-is", () => {
    const r = renderMcpContentBlock({
      content: [{ type: "image", data: "base64==", mimeType: "image/png" }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(JSON.parse(r.text).blocks[0].type).toBe("image");
  });

  it("malformed input never throws: no content array", () => {
    const r = renderMcpContentBlock({ notContent: [] });
    expect(r.ok).toBe(false);
  });

  it("malformed input never throws: block missing 'type'", () => {
    const r = renderMcpContentBlock({ content: [{ text: "no type" }] });
    expect(r.ok).toBe(false);
  });

  it("empty input", () => {
    const r = renderMcpContentBlock({ content: [] });
    expect(r.ok).toBe(false);
  });

  it("big-ish input: 200 blocks", () => {
    const content = Array.from({ length: 200 }, (_, i) => ({ type: "text", text: `t${i}` }));
    const r = renderMcpContentBlock({ content });
    expect(r.ok).toBe(true);
    if (r.ok) expect(JSON.parse(r.text).blocks).toHaveLength(200);
  });
});
