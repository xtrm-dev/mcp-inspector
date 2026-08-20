import { createServer as createNetServer, type Server as NetServer, type Socket } from "node:net";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import {
  createLineDecoder,
  encode,
  ErrorCodes,
  JSONRPC_VERSION,
  isNotification,
  isRequest,
  type JsonRpcErrorResponse,
  type JsonRpcMessage,
  type JsonRpcRequest,
  type JsonRpcSuccessResponse,
  type RunnerAuthParams,
  type RunnerSpawnSyncParams,
  type RunnerSpawnSyncResult,
} from "./protocol";

export const RUNNER_VERSION = "0.0.0";

// Bounded so a runaway command can't hold the runner open. Callers must ask
// for higher via timeoutMs, but never above HARD_MAX_TIMEOUT_MS.
export const DEFAULT_TIMEOUT_MS = 5_000;
export const HARD_MAX_TIMEOUT_MS = 60_000;
// Cap child output so a chatty subprocess can't OOM the runner. Truncated
// output is marked with a "…[truncated]" suffix on the reported buffer.
export const MAX_CAPTURED_OUTPUT_BYTES = 1 * 1024 * 1024;

export interface RunnerServerOptions {
  socketPath: string;
  token: string;
  tokenPath?: string;
}

export interface RunnerServerHandle {
  socketPath: string;
  close(): Promise<void>;
}

/**
 * Start the privileged local runner. Listens on a Unix domain socket with
 * mode 0600 on the socket file. Every connection must call
 * `runner.authenticate` with the shared token before any other method is
 * accepted.
 */
export async function startRunnerServer(options: RunnerServerOptions): Promise<RunnerServerHandle> {
  const { socketPath, token, tokenPath } = options;
  mkdirSync(dirname(socketPath), { recursive: true });
  if (existsSync(socketPath)) unlinkSync(socketPath);
  if (tokenPath) {
    mkdirSync(dirname(tokenPath), { recursive: true });
    writeFileSync(tokenPath, token, { encoding: "utf8", mode: 0o600 });
  }

  const startedAt = Date.now();
  const server: NetServer = createNetServer((socket) => attachConnection(socket, token, startedAt));

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      try {
        chmodSync(socketPath, 0o600);
      } catch {
        // best-effort; some platforms don't honor chmod on sockets
      }
      resolve();
    });
  });

  return {
    socketPath,
    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => {
          if (existsSync(socketPath)) {
            try {
              unlinkSync(socketPath);
            } catch {
              // ignore
            }
          }
          resolve();
        });
      });
    },
  };
}

export function generateAuthToken(): string {
  return randomBytes(32).toString("hex");
}

function attachConnection(socket: Socket, expectedToken: string, startedAt: number): void {
  const decoder = createLineDecoder();
  let authenticated = false;
  let closed = false;

  const send = (msg: JsonRpcMessage) => {
    if (closed) return;
    socket.write(encode(msg));
  };

  const respondError = (id: JsonRpcRequest["id"] | null, code: number, message: string) => {
    const err: JsonRpcErrorResponse = {
      jsonrpc: JSONRPC_VERSION,
      id,
      error: { code, message },
    };
    send(err);
  };

  const respondOk = (id: JsonRpcRequest["id"], result: unknown) => {
    const ok: JsonRpcSuccessResponse = {
      jsonrpc: JSONRPC_VERSION,
      id,
      result: result as JsonRpcSuccessResponse["result"],
    };
    send(ok);
  };

  socket.on("data", (chunk) => {
    const messages = decoder.push(chunk);
    for (const message of messages) {
      if (message === null) {
        respondError(null, ErrorCodes.PARSE_ERROR, "invalid JSON");
        continue;
      }
      if (isNotification(message)) continue; // no notifications supported today
      if (!isRequest(message)) continue;

      const { id, method, params } = message;

      if (method === "runner.authenticate") {
        const p = (params as RunnerAuthParams | undefined) ?? { token: "" };
        if (typeof p.token !== "string" || p.token.length === 0) {
          respondError(id, ErrorCodes.INVALID_PARAMS, "token required");
          continue;
        }
        if (!constantTimeEqual(p.token, expectedToken)) {
          respondError(id, ErrorCodes.FORBIDDEN, "invalid token");
          // Drop the connection so a brute-forcer must re-open.
          socket.end();
          closed = true;
          continue;
        }
        authenticated = true;
        respondOk(id, { ok: true, serverPid: process.pid, serverVersion: RUNNER_VERSION });
        continue;
      }

      if (!authenticated) {
        respondError(id, ErrorCodes.UNAUTHENTICATED, "authenticate first");
        continue;
      }

      switch (method) {
        case "runner.ping":
          respondOk(id, { pong: true, pid: process.pid, uptimeMs: Date.now() - startedAt });
          break;

        case "runner.spawnSync": {
          const p = (params as RunnerSpawnSyncParams | undefined) ?? { command: "" };
          if (typeof p.command !== "string" || p.command.length === 0) {
            respondError(id, ErrorCodes.INVALID_PARAMS, "command required");
            break;
          }
          runSpawnSync(p).then((result) => respondOk(id, result)).catch((err: unknown) => {
            respondError(id, ErrorCodes.INTERNAL_ERROR, errMsg(err));
          });
          break;
        }

        default:
          respondError(id, ErrorCodes.METHOD_NOT_FOUND, `unknown method '${method}'`);
      }
    }
  });

  socket.on("close", () => {
    closed = true;
  });
  socket.on("error", () => {
    closed = true;
  });
}

async function runSpawnSync(params: RunnerSpawnSyncParams): Promise<RunnerSpawnSyncResult> {
  const timeoutMs = Math.min(
    HARD_MAX_TIMEOUT_MS,
    Math.max(1, params.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  );

  const startedAt = Date.now();
  return new Promise<RunnerSpawnSyncResult>((resolve) => {
    const spawnOpts: Parameters<typeof spawn>[2] = {
      env: params.env ? { ...process.env, ...params.env } : process.env,
      stdio: ["pipe", "pipe", "pipe"],
    };
    if (params.cwd !== undefined) spawnOpts.cwd = params.cwd;
    const child = spawn(params.command, params.args ?? [], spawnOpts);

    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    let stdoutTruncated = false;
    let stderrTruncated = false;

    const captureStdout = (buf: Buffer) => {
      if (stdoutBytes >= MAX_CAPTURED_OUTPUT_BYTES) {
        stdoutTruncated = true;
        return;
      }
      const remaining = MAX_CAPTURED_OUTPUT_BYTES - stdoutBytes;
      if (buf.byteLength <= remaining) {
        stdoutChunks.push(buf.toString("utf8"));
        stdoutBytes += buf.byteLength;
      } else {
        stdoutChunks.push(buf.slice(0, remaining).toString("utf8"));
        stdoutBytes = MAX_CAPTURED_OUTPUT_BYTES;
        stdoutTruncated = true;
      }
    };
    const captureStderr = (buf: Buffer) => {
      if (stderrBytes >= MAX_CAPTURED_OUTPUT_BYTES) {
        stderrTruncated = true;
        return;
      }
      const remaining = MAX_CAPTURED_OUTPUT_BYTES - stderrBytes;
      if (buf.byteLength <= remaining) {
        stderrChunks.push(buf.toString("utf8"));
        stderrBytes += buf.byteLength;
      } else {
        stderrChunks.push(buf.slice(0, remaining).toString("utf8"));
        stderrBytes = MAX_CAPTURED_OUTPUT_BYTES;
        stderrTruncated = true;
      }
    };

    child.stdout?.on("data", captureStdout);
    child.stderr?.on("data", captureStderr);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      // Give it a moment, then hard-kill.
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 500);
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        exitCode: null,
        signal: null,
        stdout: (stdoutTruncated ? stdoutChunks.join("") + "…[truncated]" : stdoutChunks.join("")),
        stderr:
          (stderrTruncated ? stderrChunks.join("") + "…[truncated]" : stderrChunks.join("")) +
          (stderrChunks.length > 0 ? "\n" : "") +
          `spawn error: ${err.message}`,
        durationMs: Date.now() - startedAt,
        timedOut: false,
      });
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        exitCode: code,
        signal,
        stdout: stdoutTruncated ? stdoutChunks.join("") + "…[truncated]" : stdoutChunks.join(""),
        stderr: stderrTruncated ? stderrChunks.join("") + "…[truncated]" : stderrChunks.join(""),
        durationMs: Date.now() - startedAt,
        timedOut,
      });
    });

    if (params.stdinInput !== undefined && child.stdin) {
      child.stdin.write(params.stdinInput);
      child.stdin.end();
    }
  });
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
