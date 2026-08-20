import {
  createServer as createNetServer,
  type Server as NetServer,
  type Socket,
} from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
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
  type RunnerSpawnStdioMcpParams,
  type RunnerSpawnStdioMcpResult,
  type RunnerCloseStdioMcpParams,
  type RunnerCloseStdioMcpResult,
  type RunnerAttachCaptureSessionParams,
  type RunnerAttachCaptureSessionResult,
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
  const stdioSessions = new Map<string, StdioSession>();
  const captureIngestSessions = new Map<string, CaptureIngestSession>();
  const server: NetServer = createNetServer((socket) =>
    attachConnection(socket, token, startedAt, stdioSessions, captureIngestSessions),
  );

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
      // Kill every live stdio-MCP child before tearing down the control
      // socket, so a runner shutdown never leaks a subprocess.
      await Promise.all(
        Array.from(stdioSessions.keys()).map((sessionId) =>
          closeStdioMcpSession(sessionId, stdioSessions),
        ),
      );
      await Promise.all(
        Array.from(captureIngestSessions.values()).map((session) => closeCaptureIngestSession(session)),
      );
      captureIngestSessions.clear();
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

interface StdioSession {
  child: ChildProcess;
  pumpServer: NetServer;
  socketPath: string;
}

// A capture-ingest session is a plain N-way byte tee: the stdio-proxy
// binary dials in as one peer and writes CaptureEnvelope lines; the
// gateway dials in as another peer to read them. The runner never parses
// envelope contents — it just relays each connection's bytes to every
// other connection on the same socket (see protocol.ts CaptureEnvelope).
interface CaptureIngestSession {
  server: NetServer;
  socketPath: string;
  peers: Set<Socket>;
}

export function generateAuthToken(): string {
  return randomBytes(32).toString("hex");
}

function attachConnection(
  socket: Socket,
  expectedToken: string,
  startedAt: number,
  stdioSessions: Map<string, StdioSession>,
  captureIngestSessions: Map<string, CaptureIngestSession>,
): void {
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

        case "runner.spawnStdioMcp": {
          const p = (params as RunnerSpawnStdioMcpParams | undefined) ?? { command: "" };
          if (typeof p.command !== "string" || p.command.length === 0) {
            respondError(id, ErrorCodes.INVALID_PARAMS, "command required");
            break;
          }
          spawnStdioMcpSession(p, stdioSessions)
            .then((result) => respondOk(id, result))
            .catch((err: unknown) => {
              respondError(id, ErrorCodes.INTERNAL_ERROR, errMsg(err));
            });
          break;
        }

        case "runner.attachCaptureSession": {
          const p = (params as RunnerAttachCaptureSessionParams | undefined) ?? {};
          attachCaptureSessionHandler(p, captureIngestSessions)
            .then((result) => respondOk(id, result))
            .catch((err: unknown) => {
              respondError(id, ErrorCodes.INTERNAL_ERROR, errMsg(err));
            });
          break;
        }

        case "runner.closeStdioMcp": {
          const p = (params as RunnerCloseStdioMcpParams | undefined) ?? { sessionId: "" };
          if (typeof p.sessionId !== "string" || p.sessionId.length === 0) {
            respondError(id, ErrorCodes.INVALID_PARAMS, "sessionId required");
            break;
          }
          closeStdioMcpSession(p.sessionId, stdioSessions)
            .then((result) => respondOk(id, result))
            .catch((err: unknown) => {
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

/**
 * Spawn a stdio MCP child (the only place in the whole system allowed to
 * call child_process.spawn for one — see ADR-0003) and open a fresh Unix
 * domain socket that pumps raw bytes between it and the child's stdio:
 * socket → child.stdin, child.stdout → socket. Framing is the caller's
 * (the SDK adapter's) concern; the runner is just a byte pipe. Child
 * stderr is logged to the runner's own stderr with a
 * `[stdio:<sessionId>]` prefix.
 */
async function spawnStdioMcpSession(
  params: RunnerSpawnStdioMcpParams,
  sessions: Map<string, StdioSession>,
): Promise<RunnerSpawnStdioMcpResult> {
  const timeoutMs = Math.min(
    HARD_MAX_TIMEOUT_MS,
    Math.max(1, params.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  );
  const sessionId = randomBytes(12).toString("hex");
  const socketPath = join(tmpdir(), `mix-stdio-${process.pid}-${sessionId}.sock`);
  if (existsSync(socketPath)) unlinkSync(socketPath);

  const spawnOpts: Parameters<typeof spawn>[2] = {
    env: params.env ? { ...process.env, ...params.env } : process.env,
    stdio: ["pipe", "pipe", "pipe"],
  };
  if (params.cwd !== undefined) spawnOpts.cwd = params.cwd;
  const child = spawn(params.command, params.args ?? [], spawnOpts);

  child.stderr?.on("data", (buf: Buffer) => {
    process.stderr.write(`[stdio:${sessionId}] ${buf.toString("utf8")}`);
  });

  // Wait for the process to actually start (or fail to) before wiring up
  // the pump socket — a bad command should surface as an error, not a
  // socket nobody will ever connect meaningful bytes to.
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`spawnStdioMcp: '${params.command}' did not start within ${timeoutMs}ms`));
    }, timeoutMs);
    child.once("spawn", () => {
      clearTimeout(timer);
      resolve();
    });
    child.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });

  const pumpServer: NetServer = createNetServer((socket) => {
    socket.pipe(child.stdin!);
    child.stdout!.pipe(socket);
    socket.on("error", () => {
      // The gateway went away without a clean closeStdioMcp; the session
      // stays alive until explicitly closed (or the child exits on its own).
    });
  });

  await new Promise<void>((resolve, reject) => {
    pumpServer.once("error", reject);
    pumpServer.listen(socketPath, () => {
      pumpServer.off("error", reject);
      try {
        chmodSync(socketPath, 0o600);
      } catch {
        // best-effort; some platforms don't honor chmod on sockets
      }
      resolve();
    });
  });

  const session: StdioSession = { child, pumpServer, socketPath };
  sessions.set(sessionId, session);

  // Best-effort cleanup if the child dies on its own (crash, normal exit)
  // without the gateway ever calling closeStdioMcp.
  child.once("exit", () => {
    if (sessions.get(sessionId) !== session) return;
    sessions.delete(sessionId);
    pumpServer.close();
    if (existsSync(socketPath)) {
      try {
        unlinkSync(socketPath);
      } catch {
        // ignore
      }
    }
  });

  return { sessionId, socketPath };
}

/**
 * Open a fresh capture-ingest UDS: a plain byte tee that fans each
 * connected peer's bytes out to every other peer. The stdio-proxy binary
 * connects as one peer (writer); the gateway connects as another (reader)
 * before ever handing the socket path to a proxy invocation, so the
 * reader is always attached before the proxy's first byte. Single-client
 * per session by design (see bead NON_GOALS — no multiplexing).
 */
async function attachCaptureSessionHandler(
  _params: RunnerAttachCaptureSessionParams,
  sessions: Map<string, CaptureIngestSession>,
): Promise<RunnerAttachCaptureSessionResult> {
  const sessionId = randomBytes(12).toString("hex");
  const socketPath = join(tmpdir(), `mix-capture-${process.pid}-${sessionId}.sock`);
  if (existsSync(socketPath)) unlinkSync(socketPath);

  const peers = new Set<Socket>();
  const server: NetServer = createNetServer((socket) => {
    peers.add(socket);
    socket.on("data", (chunk) => {
      for (const peer of peers) {
        if (peer !== socket && !peer.destroyed) peer.write(chunk);
      }
    });
    const drop = () => peers.delete(socket);
    socket.on("close", drop);
    socket.on("error", drop);
  });

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

  sessions.set(sessionId, { server, socketPath, peers });
  return { sessionId, socketPath };
}

async function closeCaptureIngestSession(session: CaptureIngestSession): Promise<void> {
  for (const peer of session.peers) {
    peer.destroy();
  }
  session.peers.clear();
  await new Promise<void>((resolve) => session.server.close(() => resolve()));
  if (existsSync(session.socketPath)) {
    try {
      unlinkSync(session.socketPath);
    } catch {
      // ignore
    }
  }
}

async function closeStdioMcpSession(
  sessionId: string,
  sessions: Map<string, StdioSession>,
): Promise<RunnerCloseStdioMcpResult> {
  const session = sessions.get(sessionId);
  if (!session) return { closed: true };
  sessions.delete(sessionId);

  await terminateChild(session.child);
  await new Promise<void>((resolve) => session.pumpServer.close(() => resolve()));
  if (existsSync(session.socketPath)) {
    try {
      unlinkSync(session.socketPath);
    } catch {
      // ignore
    }
  }
  return { closed: true };
}

function terminateChild(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const killTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, 3_000);
    child.once("exit", () => {
      clearTimeout(killTimer);
      resolve();
    });
    child.kill("SIGTERM");
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
