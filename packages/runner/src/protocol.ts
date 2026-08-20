// Line-delimited JSON-RPC 2.0 (LSP-style framing without the Content-Length
// header, since messages are small and short-lived on a local socket).
// Every message is a JSON object followed by exactly one \n. Newlines
// inside strings are JSON-escaped, so scanning for \n as a delimiter is safe.

export const JSONRPC_VERSION = "2.0" as const;

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [k: string]: JsonValue };

export interface JsonRpcRequest {
  jsonrpc: typeof JSONRPC_VERSION;
  id: number | string;
  method: string;
  params?: Record<string, JsonValue> | JsonValue[];
}

export interface JsonRpcNotification {
  jsonrpc: typeof JSONRPC_VERSION;
  method: string;
  params?: Record<string, JsonValue> | JsonValue[];
}

export interface JsonRpcSuccessResponse {
  jsonrpc: typeof JSONRPC_VERSION;
  id: number | string;
  result: JsonValue;
}

export interface JsonRpcErrorResponse {
  jsonrpc: typeof JSONRPC_VERSION;
  id: number | string | null;
  error: { code: number; message: string; data?: JsonValue };
}

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export const ErrorCodes = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  UNAUTHENTICATED: -32001,
  FORBIDDEN: -32002,
  TIMEOUT: -32003,
} as const;

export function encode(message: JsonRpcMessage): Buffer {
  return Buffer.from(`${JSON.stringify(message)}\n`, "utf8");
}

/**
 * Stateful line splitter. Feed it Buffers from the socket as they arrive;
 * it returns any complete messages parsed so far and buffers the trailing
 * incomplete tail. Malformed lines yield a null in the messages array so the
 * caller can respond with a PARSE_ERROR.
 *
 * Generic over the parsed shape so the same framing (newline-delimited
 * JSON) can carry either a JsonRpcMessage (the default, used by the control
 * protocol) or a CaptureEnvelope (used by the stdio-proxy ingest socket).
 */
export function createLineDecoder<T = JsonRpcMessage>(): {
  push(chunk: Buffer): Array<T | null>;
} {
  let carry = "";
  return {
    push(chunk) {
      const combined = carry + chunk.toString("utf8");
      const lines = combined.split("\n");
      carry = lines.pop() ?? "";
      const out: Array<T | null> = [];
      for (const line of lines) {
        if (line.length === 0) continue;
        try {
          out.push(JSON.parse(line) as T);
        } catch {
          out.push(null);
        }
      }
      return out;
    },
  };
}

export function isRequest(m: JsonRpcMessage): m is JsonRpcRequest {
  return "method" in m && "id" in m && m.id !== undefined && m.id !== null;
}

export function isNotification(m: JsonRpcMessage): m is JsonRpcNotification {
  return "method" in m && !("id" in m);
}

export function isResponse(m: JsonRpcMessage): m is JsonRpcResponse {
  return "id" in m && ("result" in m || "error" in m);
}

// ---- Runner surface (typed contract shared by client + server) ----

export interface RunnerAuthParams {
  token: string;
}
export interface RunnerAuthResult {
  ok: true;
  serverPid: number;
  serverVersion: string;
}

export interface RunnerPingResult {
  pong: true;
  pid: number;
  uptimeMs: number;
}

export interface RunnerSpawnSyncParams {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  timeoutMs?: number;
  stdinInput?: string;
}
export interface RunnerSpawnSyncResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export interface RunnerSpawnStdioMcpParams {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}
export interface RunnerSpawnStdioMcpResult {
  sessionId: string;
  socketPath: string;
}

export interface RunnerCloseStdioMcpParams {
  sessionId: string;
}
export interface RunnerCloseStdioMcpResult {
  closed: true;
}

// ---- stdio-proxy capture ingest (Phase L slice 3) ----
//
// The stdio-proxy binary (spawned directly by an external agent, never by
// the gateway/runner) taps every JSON-RPC message flowing between the
// external agent and the real MCP child it wraps, and writes one
// CaptureEnvelope per line to the UDS the runner hands back here. The
// runner itself never interprets envelope contents — it just fans each
// connection's bytes out to every other connection on the same ingest
// socket (the gateway dials in as the other peer and persists what it
// reads). See packages/runner/src/stdio-proxy.mjs and
// apps/gateway/src/routes.ts.
export type CaptureDirection = "to-target" | "to-client";

export interface CaptureEnvelope {
  direction: CaptureDirection;
  ts: number;
  message: JsonRpcMessage;
}

export interface RunnerAttachCaptureSessionParams {
  label?: string;
}
export interface RunnerAttachCaptureSessionResult {
  sessionId: string;
  socketPath: string;
}

// ---- OS keychain (Phase I slice 2) ----
export interface RunnerKeychainGetParams {
  service: string;
  account: string;
}
export interface RunnerKeychainGetResult {
  value: string | null;
}
export interface RunnerKeychainSetParams {
  service: string;
  account: string;
  value: string;
}
export interface RunnerKeychainSetResult {
  ok: true;
}
export interface RunnerKeychainDeleteParams {
  service: string;
  account: string;
}
export interface RunnerKeychainDeleteResult {
  ok: true;
}

export type RunnerMethodMap = {
  "runner.authenticate": { params: RunnerAuthParams; result: RunnerAuthResult };
  "runner.ping": { params: Record<string, never>; result: RunnerPingResult };
  "runner.spawnSync": { params: RunnerSpawnSyncParams; result: RunnerSpawnSyncResult };
  "runner.spawnStdioMcp": { params: RunnerSpawnStdioMcpParams; result: RunnerSpawnStdioMcpResult };
  "runner.closeStdioMcp": { params: RunnerCloseStdioMcpParams; result: RunnerCloseStdioMcpResult };
  "runner.attachCaptureSession": {
    params: RunnerAttachCaptureSessionParams;
    result: RunnerAttachCaptureSessionResult;
  };
  "runner.keychainGet": { params: RunnerKeychainGetParams; result: RunnerKeychainGetResult };
  "runner.keychainSet": { params: RunnerKeychainSetParams; result: RunnerKeychainSetResult };
  "runner.keychainDelete": { params: RunnerKeychainDeleteParams; result: RunnerKeychainDeleteResult };
};

export type RunnerMethod = keyof RunnerMethodMap;
