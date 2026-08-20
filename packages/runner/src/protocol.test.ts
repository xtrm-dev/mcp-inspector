import { describe, expect, it } from "vitest";
import {
  createLineDecoder,
  encode,
  isNotification,
  isRequest,
  isResponse,
  JSONRPC_VERSION,
} from "./protocol";

describe("json-rpc framing", () => {
  it("encodes a request as a single JSON line followed by \\n", () => {
    const buf = encode({ jsonrpc: JSONRPC_VERSION, id: 1, method: "runner.ping", params: {} });
    const s = buf.toString("utf8");
    expect(s.endsWith("\n")).toBe(true);
    expect(s.split("\n").filter(Boolean)).toHaveLength(1);
    expect(JSON.parse(s)).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "runner.ping",
      params: {},
    });
  });

  it("splits multiple messages arriving in a single chunk", () => {
    const dec = createLineDecoder();
    const chunk = Buffer.concat([
      encode({ jsonrpc: JSONRPC_VERSION, id: 1, method: "a" }),
      encode({ jsonrpc: JSONRPC_VERSION, id: 2, method: "b" }),
    ]);
    const out = dec.push(chunk);
    expect(out).toHaveLength(2);
    expect((out[0] as { id: number }).id).toBe(1);
    expect((out[1] as { id: number }).id).toBe(2);
  });

  it("buffers a message split across chunks", () => {
    const dec = createLineDecoder();
    const full = encode({ jsonrpc: JSONRPC_VERSION, id: 42, method: "foo" });
    const mid = Math.floor(full.byteLength / 2);
    const first = dec.push(full.slice(0, mid));
    expect(first).toHaveLength(0);
    const second = dec.push(full.slice(mid));
    expect(second).toHaveLength(1);
    expect((second[0] as { id: number }).id).toBe(42);
  });

  it("reports null for malformed lines without derailing subsequent parses", () => {
    const dec = createLineDecoder();
    const chunk = Buffer.from(
      "not-json\n" +
        encode({ jsonrpc: JSONRPC_VERSION, id: 9, method: "b" }).toString("utf8"),
      "utf8",
    );
    const out = dec.push(chunk);
    expect(out).toHaveLength(2);
    expect(out[0]).toBeNull();
    expect((out[1] as { id: number }).id).toBe(9);
  });

  it("type guards separate request / notification / response", () => {
    expect(isRequest({ jsonrpc: JSONRPC_VERSION, id: 1, method: "x" })).toBe(true);
    expect(isNotification({ jsonrpc: JSONRPC_VERSION, method: "x" })).toBe(true);
    expect(isResponse({ jsonrpc: JSONRPC_VERSION, id: 1, result: null })).toBe(true);
    expect(isResponse({ jsonrpc: JSONRPC_VERSION, id: 1, error: { code: -1, message: "" } })).toBe(true);
    // A request has id AND method; a response has id AND (result|error). They can look similar,
    // but a message with `method` and no result/error is a request, not a response.
    expect(isResponse({ jsonrpc: JSONRPC_VERSION, id: 1, method: "x" })).toBe(false);
  });
});
