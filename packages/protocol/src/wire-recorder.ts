// HTTP wire recorder: captures raw request + response bytes for the
// Streamable HTTP path so Inspector can persist authoritative
// `raw_request` / `raw_response` artifacts (matching the shape stdio-proxy
// already emits). Wraps `fetch` and buffers response bodies via a
// TransformStream so the SDK still sees the original streaming semantics.
//
// ponytail: request-body bytes come from the `init.body` value we were
// handed (Uint8Array | string | ArrayBuffer | null). We do not re-stream a
// ReadableStream request body — the MCP HTTP transport does not send them.

export interface WireStreamMark {
  /** Elapsed ms from the moment the outbound request was dispatched. */
  atMs: number;
  event: "open" | "data" | "end" | "error";
  /** Byte count of this chunk, only present on `data` events. */
  size?: number;
  /** Error message, only present on `error` events. */
  error?: string;
}

export interface WireRequestCapture {
  method: string;
  url: string;
  /** Header names lower-cased. `authorization`, `cookie`, `proxy-authorization` values are always replaced with `[REDACTED]`. */
  headers: Record<string, string>;
  /** Request body as base64, or null if no body was sent. */
  bodyBase64: string | null;
}

export interface WireResponseCapture {
  status: number;
  statusText: string;
  /** Header names lower-cased. `set-cookie` values are replaced with `[REDACTED]`. */
  headers: Record<string, string>;
  /** Response body as base64, or null if the stream errored before any bytes arrived. */
  bodyBase64: string | null;
  streamMarks: WireStreamMark[];
  /** Present iff `fetch` itself rejected (no response was received). */
  error?: string;
}

export interface WireCapture {
  request: WireRequestCapture;
  response: WireResponseCapture | null;
  /** ISO timestamp of when the outbound request was dispatched. */
  startedAt: string;
  /** ms wall-clock from dispatch to `end` / `error`. */
  durationMs: number;
}

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface WireRecorderOptions {
  /**
   * Called on every persisted header value + on the request body when it is
   * decodable as UTF-8. Use `SecretsRegistry.scrub` from the gateway so any
   * value the registry has ever seen (bearer tokens, custom-header secrets,
   * OAuth access/refresh tokens) is replaced with `[REDACTED]` before it
   * reaches disk. Response bodies are NOT scrubbed here — they are raw
   * server bytes; the caller runs its own scrub before persisting.
   */
  redact?: (s: string) => string;
  baseFetch?: FetchLike;
}

export interface WireRecorder {
  fetch: FetchLike;
  /** Take and clear the last captured wire round. Call after `client.callTool()` resolves. */
  drain(): WireCapture | null;
}

const ALWAYS_REDACT_REQ = new Set(["authorization", "cookie", "proxy-authorization"]);
const ALWAYS_REDACT_RES = new Set(["set-cookie"]);
const REDACTED = "[REDACTED]";

function normalizeHeaders(
  raw: HeadersInit | undefined,
  alwaysRedact: ReadonlySet<string>,
  redact: (s: string) => string,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  const collect = (name: string, value: string) => {
    const lower = name.toLowerCase();
    out[lower] = alwaysRedact.has(lower) ? REDACTED : redact(value);
  };
  if (raw instanceof Headers) {
    raw.forEach((value, name) => collect(name, value));
  } else if (Array.isArray(raw)) {
    for (const [name, value] of raw) collect(name, value);
  } else {
    for (const [name, value] of Object.entries(raw)) {
      if (typeof value === "string") collect(name, value);
    }
  }
  return out;
}

function headersFromResponse(
  headers: Headers,
  redact: (s: string) => string,
): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, name) => {
    const lower = name.toLowerCase();
    out[lower] = ALWAYS_REDACT_RES.has(lower) ? REDACTED : redact(value);
  });
  return out;
}

function bodyToBytes(body: BodyInit | null | undefined): Uint8Array | null {
  if (body === null || body === undefined) return null;
  if (body instanceof Uint8Array) return body;
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  }
  // URLSearchParams, FormData, Blob, ReadableStream — MCP's HTTP transport
  // does not send any of these; recording as null is honest.
  return null;
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function scrubBodyIfText(
  bytes: Uint8Array,
  contentType: string,
  redact: (s: string) => string,
): Uint8Array {
  if (redact === identityRedact) return bytes;
  const ct = contentType.toLowerCase();
  const looksTextual =
    ct.startsWith("application/json") ||
    ct.startsWith("text/") ||
    ct.startsWith("application/x-www-form-urlencoded");
  if (!looksTextual) return bytes;
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const scrubbed = redact(decoded);
    if (scrubbed === decoded) return bytes;
    return new TextEncoder().encode(scrubbed);
  } catch {
    return bytes;
  }
}

function concat(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

const identityRedact = (s: string) => s;

export function createWireRecorder(options: WireRecorderOptions = {}): WireRecorder {
  const redact = options.redact ?? identityRedact;
  const baseFetch: FetchLike = options.baseFetch ?? ((u, i) => fetch(u, i));
  let last: WireCapture | null = null;

  const recorderFetch: FetchLike = async (input, init) => {
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();

    const reqHeaders = normalizeHeaders(init?.headers, ALWAYS_REDACT_REQ, redact);
    const reqBodyBytes = bodyToBytes(init?.body ?? null);
    const reqCT = reqHeaders["content-type"] ?? "";
    const persistedReqBytes = reqBodyBytes ? scrubBodyIfText(reqBodyBytes, reqCT, redact) : null;

    const request: WireRequestCapture = {
      method,
      url,
      headers: reqHeaders,
      bodyBase64: persistedReqBytes ? toBase64(persistedReqBytes) : null,
    };

    let response: Response;
    try {
      response = await baseFetch(input, init);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      last = {
        request,
        response: {
          status: 0,
          statusText: "",
          headers: {},
          bodyBase64: null,
          streamMarks: [{ atMs: Date.now() - startedAtMs, event: "error", error: errMsg }],
          error: errMsg,
        },
        startedAt,
        durationMs: Date.now() - startedAtMs,
      };
      throw err;
    }

    const marks: WireStreamMark[] = [{ atMs: Date.now() - startedAtMs, event: "open" }];
    const respHeaders = headersFromResponse(response.headers, redact);
    const respCT = respHeaders["content-type"] ?? "";

    // Preemptively record the response envelope so a caller that drains
    // before the body finishes still gets useful data. bodyBase64 is filled
    // in when the stream flushes (below) or immediately for empty bodies.
    const capture: WireCapture = {
      request,
      response: {
        status: response.status,
        statusText: response.statusText,
        headers: respHeaders,
        bodyBase64: null,
        streamMarks: marks,
      },
      startedAt,
      durationMs: Date.now() - startedAtMs,
    };
    last = capture;

    if (response.body === null) {
      marks.push({ atMs: Date.now() - startedAtMs, event: "end" });
      capture.durationMs = Date.now() - startedAtMs;
      return response;
    }

    const chunks: Uint8Array[] = [];
    const transform = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        chunks.push(chunk);
        marks.push({ atMs: Date.now() - startedAtMs, event: "data", size: chunk.byteLength });
        controller.enqueue(chunk);
      },
      flush() {
        marks.push({ atMs: Date.now() - startedAtMs, event: "end" });
        const joined = concat(chunks);
        const persisted = scrubBodyIfText(joined, respCT, redact);
        if (capture.response) capture.response.bodyBase64 = toBase64(persisted);
        capture.durationMs = Date.now() - startedAtMs;
      },
    });

    return new Response(response.body.pipeThrough(transform), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };

  return {
    fetch: recorderFetch,
    drain() {
      const c = last;
      last = null;
      return c;
    },
  };
}
