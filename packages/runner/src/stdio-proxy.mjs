#!/usr/bin/env node
// Transparent stdio proxy (ADR-0002): an external agent (Claude Code,
// cursor, etc.) spawns THIS binary instead of the real MCP server. It
// spawns the real server as a child and forwards stdin/stdout between the
// agent and the child byte-for-byte — the same Buffer chunks, unmodified,
// same order, same timing. In parallel it taps (never blocks on) each
// framed JSON-RPC line and writes a CaptureEnvelope to the ingest UDS the
// gateway handed out via runner.attachCaptureSession, so the Inspector can
// observe traffic it never routed itself.
//
// Plain JS (no TS build step, no repo imports) — same convention as
// demo-mcp-stdio.mjs, so the binary runs with a bare `node` and nothing else.
import { spawn } from "node:child_process";
import { connect } from "node:net";

export function parseArgs(argv) {
  const args = argv.slice();

  let ingestPath;
  const ingestIdx = args.indexOf("--ingest");
  if (ingestIdx !== -1) {
    ingestPath = args[ingestIdx + 1];
    args.splice(ingestIdx, 2);
  }

  const targetIdx = args.indexOf("--target");
  if (targetIdx === -1) {
    throw new Error("--target <command> [args...] is required");
  }
  const targetParts = args.slice(targetIdx + 1);
  const [command, ...targetArgs] = targetParts;
  if (!command) {
    throw new Error("--target requires a command");
  }
  return { command, targetArgs, ingestPath };
}

// Minimal newline-delimited-JSON tap. Splits on \n, JSON.parses each
// complete line; malformed/partial lines are silently skipped — the tap is
// a passive observer, never a validator, and it never touches the bytes it
// is fed (those are forwarded separately, untouched, via pipe()).
export function createTap(onMessage) {
  let carry = "";
  return (chunk) => {
    carry += chunk.toString("utf8");
    const lines = carry.split("\n");
    carry = lines.pop() ?? "";
    for (const line of lines) {
      if (line.length === 0) continue;
      try {
        onMessage(JSON.parse(line));
      } catch {
        // not a complete/valid JSON-RPC line — skip, never throw
      }
    }
  };
}

async function main() {
  const { command, targetArgs, ingestPath } = parseArgs(process.argv.slice(2));

  const child = spawn(command, targetArgs, { stdio: ["pipe", "pipe", "inherit"] });

  // Ingest is best-effort: if the socket is unavailable (or ever errors),
  // log a warning and keep forwarding — the proxy must never block the
  // target on capture infrastructure being down.
  let ingestSocket = null;
  if (ingestPath) {
    ingestSocket = connect(ingestPath);
    ingestSocket.on("error", (err) => {
      process.stderr.write(
        `mcp-inspector-x-stdio-proxy: ingest socket unavailable (${err.message}); continuing without capture\n`,
      );
      ingestSocket = null;
    });
  } else {
    process.stderr.write(
      "mcp-inspector-x-stdio-proxy: no --ingest socket given; running without capture\n",
    );
  }

  const tee = (direction) => (message) => {
    if (!ingestSocket || ingestSocket.destroyed) return;
    try {
      ingestSocket.write(`${JSON.stringify({ direction, ts: Date.now(), message })}\n`);
    } catch (err) {
      process.stderr.write(
        `mcp-inspector-x-stdio-proxy: capture write failed (${err instanceof Error ? err.message : String(err)}); continuing without capture\n`,
      );
    }
  };

  // Transparent forwarding via pipe() — raw Buffer chunks, untouched order
  // and timing. The tap below is a second, independent 'data' listener on
  // the same readable stream; Node delivers each chunk to every listener,
  // so it never consumes, reorders, or delays what pipe() forwards.
  process.stdin.on("data", createTap(tee("to-target")));
  process.stdin.pipe(child.stdin);

  child.stdout.on("data", createTap(tee("to-client")));
  child.stdout.pipe(process.stdout);

  child.on("exit", (code, signal) => {
    ingestSocket?.end();
    process.exit(code ?? (signal ? 1 : 0));
  });
  child.on("error", (err) => {
    process.stderr.write(`mcp-inspector-x-stdio-proxy: failed to start target: ${err.message}\n`);
    process.exit(1);
  });

  process.on("SIGINT", () => child.kill("SIGINT"));
  process.on("SIGTERM", () => child.kill("SIGTERM"));
}

// Only run when executed directly (not when imported for unit-testing
// parseArgs/createTap).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`mcp-inspector-x-stdio-proxy: ${err.message}\n`);
    process.exit(1);
  });
}
