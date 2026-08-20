import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  startRunnerServer,
  generateAuthToken,
  connectRunnerClient,
  RunnerRpcError,
  ErrorCodes,
  type RunnerServerHandle,
} from "./index";

describe("runner server ↔ client (unix domain socket + shared-secret auth)", () => {
  let dir: string;
  let socketPath: string;
  let tokenPath: string;
  let token: string;
  let server: RunnerServerHandle;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "mix-runner-"));
    socketPath = join(dir, "runner.sock");
    tokenPath = join(dir, "runner.token");
    token = generateAuthToken();
    server = await startRunnerServer({ socketPath, token, tokenPath });
  });

  afterEach(async () => {
    await server?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes the token file with mode 0600", () => {
    expect(existsSync(tokenPath)).toBe(true);
    const s = statSync(tokenPath);
    // low 9 bits; owner-read+owner-write = 0o600
    expect(s.mode & 0o777).toBe(0o600);
  });

  it("client can authenticate and ping the runner", async () => {
    const client = await connectRunnerClient({ socketPath, tokenPath });
    try {
      const pong = await client.ping();
      expect(pong.pong).toBe(true);
      expect(pong.pid).toBe(process.pid);
      expect(pong.uptimeMs).toBeGreaterThanOrEqual(0);
    } finally {
      await client.close();
    }
  });

  it("client can execute a bounded subprocess via runner.spawnSync", async () => {
    const client = await connectRunnerClient({ socketPath, token });
    try {
      const r = await client.spawnSync({
        command: process.execPath,
        args: ["-e", "console.log('hi'); console.error('warn'); process.exit(3)"],
        timeoutMs: 5000,
      });
      expect(r.exitCode).toBe(3);
      expect(r.stdout.trim()).toBe("hi");
      expect(r.stderr.trim()).toBe("warn");
      expect(r.timedOut).toBe(false);
      expect(r.durationMs).toBeGreaterThanOrEqual(0);
    } finally {
      await client.close();
    }
  });

  it("rejects unauthenticated method calls", async () => {
    // Bypass connectRunnerClient (which auths for us) and speak raw.
    const { connect } = await import("node:net");
    const { encode } = await import("./protocol");
    const socket = await new Promise<import("node:net").Socket>((resolve, reject) => {
      const s = connect(socketPath);
      s.once("connect", () => resolve(s));
      s.once("error", reject);
    });
    const responses: unknown[] = [];
    socket.on("data", (c) => {
      for (const line of c.toString("utf8").split("\n").filter(Boolean)) {
        responses.push(JSON.parse(line));
      }
    });
    socket.write(encode({ jsonrpc: "2.0", id: 1, method: "runner.ping", params: {} }));
    await new Promise((r) => setTimeout(r, 200));
    expect(responses).toHaveLength(1);
    expect((responses[0] as { error: { code: number } }).error.code).toBe(
      ErrorCodes.UNAUTHENTICATED,
    );
    socket.end();
  });

  it("wrong token is rejected and the connection is closed", async () => {
    await expect(
      connectRunnerClient({ socketPath, token: "0".repeat(64) }),
    ).rejects.toBeInstanceOf(RunnerRpcError);
  });

  it("enforces a per-call timeout on spawned subprocesses", async () => {
    const client = await connectRunnerClient({ socketPath, tokenPath });
    try {
      const r = await client.spawnSync({
        command: process.execPath,
        args: ["-e", "setTimeout(() => {}, 60000)"],
        timeoutMs: 250,
      });
      expect(r.timedOut).toBe(true);
      // SIGTERM first, escalates to SIGKILL if unhandled. Either counts.
      expect(r.signal === "SIGTERM" || r.signal === "SIGKILL").toBe(true);
    } finally {
      await client.close();
    }
  }, 5000);

  it("returns METHOD_NOT_FOUND for unknown methods", async () => {
    const client = await connectRunnerClient({ socketPath, token });
    try {
      await expect(
        client.call(
          "runner.doesNotExist" as unknown as "runner.ping",
          {} as unknown as Record<string, never>,
        ),
      ).rejects.toMatchObject({ code: ErrorCodes.METHOD_NOT_FOUND });
    } finally {
      await client.close();
    }
  });

  it("multiplexes concurrent requests over one connection", async () => {
    const client = await connectRunnerClient({ socketPath, tokenPath });
    try {
      const results = await Promise.all([client.ping(), client.ping(), client.ping()]);
      expect(results).toHaveLength(3);
      for (const r of results) expect(r.pong).toBe(true);
    } finally {
      await client.close();
    }
  });

  describe("runner.spawnStdioMcp / runner.closeStdioMcp (byte pump for a runner-spawned child)", () => {
    it("pumps raw bytes socket<->child.stdin/stdout, then closeStdioMcp kills the child and unlinks the socket", async () => {
      const client = await connectRunnerClient({ socketPath, tokenPath });
      try {
        const { sessionId, socketPath: pumpSocketPath } = await client.spawnStdioMcp({
          command: process.execPath,
          // A trivial echo child stands in for an MCP server: the runner's
          // job here is only to pump bytes, not to understand them.
          args: ["-e", "process.stdin.pipe(process.stdout)"],
        });
        expect(existsSync(pumpSocketPath)).toBe(true);

        const { connect } = await import("node:net");
        const pumpSocket = await new Promise<import("node:net").Socket>((resolve, reject) => {
          const s = connect(pumpSocketPath);
          s.once("connect", () => resolve(s));
          s.once("error", reject);
        });

        const echoed = new Promise<string>((resolve) => {
          pumpSocket.once("data", (buf: Buffer) => resolve(buf.toString("utf8")));
        });
        pumpSocket.write("hello stdio\n");
        await expect(echoed).resolves.toBe("hello stdio\n");
        pumpSocket.end();

        const result = await client.closeStdioMcp({ sessionId });
        expect(result.closed).toBe(true);
        expect(existsSync(pumpSocketPath)).toBe(false);
      } finally {
        await client.close();
      }
    }, 10_000);

    it("closeStdioMcp is idempotent for an unknown sessionId", async () => {
      const client = await connectRunnerClient({ socketPath, tokenPath });
      try {
        const result = await client.closeStdioMcp({ sessionId: "does-not-exist" });
        expect(result.closed).toBe(true);
      } finally {
        await client.close();
      }
    });

    it("rejects spawnStdioMcp with a missing command", async () => {
      const client = await connectRunnerClient({ socketPath, tokenPath });
      try {
        await expect(
          client.spawnStdioMcp({ command: "" }),
        ).rejects.toMatchObject({ code: ErrorCodes.INVALID_PARAMS });
      } finally {
        await client.close();
      }
    });

    it("runner shutdown kills any still-live stdio-MCP sessions", async () => {
      const client = await connectRunnerClient({ socketPath, tokenPath });
      const { socketPath: pumpSocketPath } = await client.spawnStdioMcp({
        command: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000)"],
      });
      expect(existsSync(pumpSocketPath)).toBe(true);
      await client.close();
      await server.close();
      expect(existsSync(pumpSocketPath)).toBe(false);
    }, 10_000);
  });
});
