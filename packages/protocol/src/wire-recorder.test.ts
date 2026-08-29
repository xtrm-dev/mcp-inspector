import { describe, expect, it } from "vitest";
import { createWireRecorder, type FetchLike } from "./wire-recorder";

function base64ToUtf8(b64: string): string {
  return Buffer.from(b64, "base64").toString("utf8");
}

describe("wire-recorder", () => {
  it("captures request+response bytes for a JSON round-trip", async () => {
    const baseFetch: FetchLike = async (_url, init) => {
      expect(init?.method).toBe("POST");
      return new Response('{"result":"ok"}', {
        status: 200,
        headers: { "content-type": "application/json", "x-server": "test" },
      });
    };
    const rec = createWireRecorder({ baseFetch });

    const res = await rec.fetch("https://example.test/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", "authorization": "Bearer sekret" },
      body: '{"jsonrpc":"2.0","method":"tools/call","id":1}',
    });
    const bodyText = await res.text();
    expect(bodyText).toBe('{"result":"ok"}');

    const wire = rec.drain();
    expect(wire).not.toBeNull();
    expect(wire!.request.method).toBe("POST");
    expect(wire!.request.url).toBe("https://example.test/mcp");
    expect(wire!.request.headers["content-type"]).toBe("application/json");
    expect(base64ToUtf8(wire!.request.bodyBase64!)).toBe(
      '{"jsonrpc":"2.0","method":"tools/call","id":1}',
    );
    expect(wire!.response).not.toBeNull();
    expect(wire!.response!.status).toBe(200);
    expect(wire!.response!.headers["content-type"]).toBe("application/json");
    expect(base64ToUtf8(wire!.response!.bodyBase64!)).toBe('{"result":"ok"}');

    const events = wire!.response!.streamMarks.map((m) => m.event);
    expect(events[0]).toBe("open");
    expect(events).toContain("data");
    expect(events[events.length - 1]).toBe("end");
  });

  it("redacts Authorization, Cookie, Proxy-Authorization request headers unconditionally", async () => {
    const baseFetch: FetchLike = async () => new Response(null, { status: 204 });
    const rec = createWireRecorder({ baseFetch });

    await rec.fetch("https://example.test/x", {
      method: "GET",
      headers: {
        "Authorization": "Bearer abc123-plaintext",
        "Cookie": "session=xyz",
        "Proxy-Authorization": "Basic Zm9vOmJhcg==",
        "X-Trace": "keep-me",
      },
    });

    const wire = rec.drain();
    expect(wire!.request.headers["authorization"]).toBe("[REDACTED]");
    expect(wire!.request.headers["cookie"]).toBe("[REDACTED]");
    expect(wire!.request.headers["proxy-authorization"]).toBe("[REDACTED]");
    expect(wire!.request.headers["x-trace"]).toBe("keep-me");
    // Plaintext bearer token MUST NOT appear anywhere in the persisted request.
    expect(JSON.stringify(wire!.request)).not.toContain("abc123-plaintext");
  });

  it("runs redact() over non-blocklisted header values and text-shaped bodies", async () => {
    const baseFetch: FetchLike = async () =>
      new Response('{"ok":true,"echo":"topsecret"}', {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const rec = createWireRecorder({
      baseFetch,
      redact: (s) => s.split("topsecret").join("[REDACTED]"),
    });

    const res = await rec.fetch("https://example.test/x", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "topsecret" },
      body: '{"input":"topsecret"}',
    });
    // Downstream still sees the untouched response body — redaction is only
    // applied to the persisted capture, never the passthrough to the SDK.
    expect(await res.text()).toBe('{"ok":true,"echo":"topsecret"}');

    const wire = rec.drain();
    expect(wire!.request.headers["x-api-key"]).toBe("[REDACTED]");
    expect(base64ToUtf8(wire!.request.bodyBase64!)).toBe('{"input":"[REDACTED]"}');
    expect(base64ToUtf8(wire!.response!.bodyBase64!)).toBe(
      '{"ok":true,"echo":"[REDACTED]"}',
    );
  });

  it("drain() returns null after being taken and resets between calls", async () => {
    const baseFetch: FetchLike = async () => new Response("hi", { status: 200 });
    const rec = createWireRecorder({ baseFetch });
    await (await rec.fetch("https://example.test/a")).text();
    expect(rec.drain()).not.toBeNull();
    expect(rec.drain()).toBeNull();
    await (await rec.fetch("https://example.test/b")).text();
    const second = rec.drain();
    expect(second).not.toBeNull();
    expect(second!.request.url).toBe("https://example.test/b");
  });

  it("records an error capture when the underlying fetch rejects", async () => {
    const rec = createWireRecorder({
      baseFetch: async () => {
        throw new Error("dns failure");
      },
    });
    await expect(rec.fetch("https://example.test/x", { method: "POST" })).rejects.toThrow(
      "dns failure",
    );
    const wire = rec.drain();
    expect(wire).not.toBeNull();
    expect(wire!.response?.error).toBe("dns failure");
    expect(wire!.response?.streamMarks[0]?.event).toBe("error");
  });
});
