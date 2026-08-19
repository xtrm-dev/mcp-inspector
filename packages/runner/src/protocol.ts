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
 */
export function createLineDecoder(): {
  push(chunk: Buffer): Array<JsonRpcMessage | null>;
} {
  let carry = "";
  return {
    push(chunk) {
      const combined = carry + chunk.toString("utf8");
      const lines = combined.split("\n");
      carry = lines.pop() ?? "";
      const out: Array<JsonRpcMessage | null> = [];
      for (const line of lines) {
        if (line.length === 0) continue;
        try {
          out.push(JSON.parse(line) as JsonRpcMessage);
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

export type RunnerMethodMap = {
  "runner.authenticate": { params: RunnerAuthParams; result: RunnerAuthResult };
  "runner.ping": { params: Record<string, never>; result: RunnerPingResult };
  "runner.spawnSync": { params: RunnerSpawnSyncParams; result: RunnerSpawnSyncResult };
};

export type RunnerMethod = keyof RunnerMethodMap;
