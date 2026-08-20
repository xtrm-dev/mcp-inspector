import { connect as netConnect, type Socket } from "node:net";
import { readFileSync } from "node:fs";
import {
  createLineDecoder,
  encode,
  ErrorCodes,
  JSONRPC_VERSION,
  isResponse,
  type JsonRpcErrorResponse,
  type JsonRpcMessage,
  type JsonRpcSuccessResponse,
  type RunnerMethod,
  type RunnerMethodMap,
} from "./protocol";

export interface RunnerClientOptions {
  socketPath: string;
  token?: string;
  tokenPath?: string;
  requestTimeoutMs?: number;
}

export interface RunnerClient {
  call<M extends RunnerMethod>(
    method: M,
    params: RunnerMethodMap[M]["params"],
  ): Promise<RunnerMethodMap[M]["result"]>;
  ping(): Promise<RunnerMethodMap["runner.ping"]["result"]>;
  spawnSync(
    params: RunnerMethodMap["runner.spawnSync"]["params"],
  ): Promise<RunnerMethodMap["runner.spawnSync"]["result"]>;
  close(): Promise<void>;
}

export class RunnerRpcError extends Error {
  constructor(
    public code: number,
    message: string,
    public data?: unknown,
  ) {
    super(message);
    this.name = "RunnerRpcError";
  }
}

/**
 * Connect to a running local runner and authenticate. Returns a typed
 * client whose lifetime owns a single duplex socket. Concurrent calls are
 * multiplexed by JSON-RPC id.
 */
export async function connectRunnerClient(options: RunnerClientOptions): Promise<RunnerClient> {
  const token = options.token ?? (options.tokenPath ? readFileSync(options.tokenPath, "utf8").trim() : undefined);
  if (!token) throw new Error("runner client: token (or tokenPath) required");

  const socket: Socket = await new Promise((resolve, reject) => {
    const s = netConnect(options.socketPath);
    const onErr = (err: Error) => {
      s.off("connect", onOk);
      reject(err);
    };
    const onOk = () => {
      s.off("error", onErr);
      resolve(s);
    };
    s.once("error", onErr);
    s.once("connect", onOk);
  });

  const pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  let nextId = 1;
  let closed = false;

  const decoder = createLineDecoder();
  socket.on("data", (chunk) => {
    for (const message of decoder.push(chunk)) {
      if (message === null) continue;
      if (!isResponse(message)) continue;
      handleResponse(message);
    }
  });
  socket.on("close", () => {
    closed = true;
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(new Error("runner connection closed"));
    }
    pending.clear();
  });
  socket.on("error", (err) => {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(err);
    }
    pending.clear();
  });

  function handleResponse(msg: JsonRpcMessage) {
    if (!("id" in msg) || msg.id === null || typeof msg.id !== "number") return;
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    clearTimeout(entry.timer);
    if ("error" in msg) {
      const err = msg as JsonRpcErrorResponse;
      entry.reject(new RunnerRpcError(err.error.code, err.error.message, err.error.data));
      return;
    }
    entry.resolve((msg as JsonRpcSuccessResponse).result);
  }

  const requestTimeoutMs = options.requestTimeoutMs ?? 30_000;

  async function call<M extends RunnerMethod>(
    method: M,
    params: RunnerMethodMap[M]["params"],
  ): Promise<RunnerMethodMap[M]["result"]> {
    if (closed) throw new Error("runner client closed");
    const id = nextId++;
    const promise = new Promise<RunnerMethodMap[M]["result"]>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new RunnerRpcError(ErrorCodes.TIMEOUT, `runner call '${method}' timed out`));
      }, requestTimeoutMs);
      pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });
    });
    socket.write(
      encode({
        jsonrpc: JSONRPC_VERSION,
        id,
        method,
        params: params as Record<string, never>,
      }),
    );
    return promise;
  }

  // Authenticate before returning the handle so downstream callers never
  // race a first request against the auth ack.
  await call("runner.authenticate", { token });

  return {
    call,
    ping() {
      return call("runner.ping", {});
    },
    spawnSync(params) {
      return call("runner.spawnSync", params);
    },
    async close() {
      closed = true;
      await new Promise<void>((resolve) => {
        socket.end(() => resolve());
      });
    },
  };
}
