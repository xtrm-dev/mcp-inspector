#!/usr/bin/env node
// One-command dev supervisor: spawns runner, then gateway, then web.
// Signals propagate; on SIGINT the children are drained in reverse order.
// Uses only node:child_process to avoid a new dep just for orchestration.

import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const DATA_DIR = process.env.MIX_DATA_DIR ?? join(homedir(), ".mcp-inspector-x");
const RUNNER_SOCKET = process.env.MIX_RUNNER_SOCKET ?? join(DATA_DIR, "runner.sock");
const RUNNER_TOKEN_PATH = process.env.MIX_RUNNER_TOKEN_PATH ?? join(DATA_DIR, "runner.token");

const children = [];

function launch(name, command, args, extraEnv = {}, color) {
  const child = spawn(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...extraEnv },
  });
  const prefix = color ? `\x1b[${color}m[${name}]\x1b[0m` : `[${name}]`;
  child.stdout.on("data", (buf) => process.stdout.write(prefixLines(prefix, buf)));
  child.stderr.on("data", (buf) => process.stderr.write(prefixLines(prefix, buf)));
  child.on("exit", (code, signal) => {
    console.log(`${prefix} exited (code=${code} signal=${signal ?? "-"})`);
    // If any child dies, drain the others so the operator sees the failure
    // instead of a half-running dev environment.
    void shutdown(code ?? 1);
  });
  children.push({ name, child });
  return child;
}

function prefixLines(prefix, buf) {
  const text = buf.toString("utf8");
  return text.replace(/^/gm, `${prefix} `).replace(/\n\[.*?\] $/, "\n");
}

async function waitForSocket(path, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (existsSync(path)) return true;
    await sleep(100);
  }
  return false;
}

async function shutdown(exitCode = 0) {
  if (shutdown.done) return;
  shutdown.done = true;
  for (const { name, child } of [...children].reverse()) {
    if (child.exitCode !== null) continue;
    console.log(`shutting down ${name}…`);
    child.kill("SIGTERM");
  }
  const graceMs = 3000;
  const graceUntil = Date.now() + graceMs;
  while (children.some(({ child }) => child.exitCode === null) && Date.now() < graceUntil) {
    await sleep(50);
  }
  for (const { child } of children) {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  process.exit(exitCode);
}

process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));

launch("runner", "npm", ["run", "start", "--workspace", "@mcp-inspector-x/runner", "--silent"], {}, "35");

const ready = await waitForSocket(RUNNER_SOCKET, 10_000);
if (!ready) {
  console.error(`runner socket did not appear at ${RUNNER_SOCKET} within 10s`);
  await shutdown(1);
}

launch(
  "gateway",
  "npm",
  ["run", "dev", "--workspace", "@mcp-inspector-x/gateway", "--silent"],
  { MIX_RUNNER_SOCKET: RUNNER_SOCKET, MIX_RUNNER_TOKEN_PATH: RUNNER_TOKEN_PATH },
  "33",
);
launch("web", "npm", ["run", "dev", "--workspace", "@mcp-inspector-x/web", "--silent"], {}, "36");
