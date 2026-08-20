#!/usr/bin/env node
// Packaged product entry point (ships as ./bin.mjs inside the npm tarball,
// referenced by package.json "bin"). Same supervisor shape as
// scripts/dev.mjs — spawn runner, wait for its socket, spawn gateway with
// the web assets mounted, open the browser — but against the pre-built
// runner.mjs / gateway.mjs bundles next to this file instead of tsx +
// npm-workspace resolution.
//
// ponytail: reuses node:child_process only, same pattern as dev.mjs.

import { spawn, execFile } from "node:child_process";
import { homedir, platform } from "node:os";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.MIX_DATA_DIR ?? join(homedir(), ".mcp-inspector-x");
const RUNNER_SOCKET = process.env.MIX_RUNNER_SOCKET ?? join(DATA_DIR, "runner.sock");
const RUNNER_TOKEN_PATH = process.env.MIX_RUNNER_TOKEN_PATH ?? join(DATA_DIR, "runner.token");
const PORT = process.env.PORT ?? "6275";
const WEB_DIST = join(HERE, "web");

const children = [];

function launch(name, args, extraEnv = {}, color) {
  const child = spawn(process.execPath, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...extraEnv },
  });
  const prefix = color ? `\x1b[${color}m[${name}]\x1b[0m` : `[${name}]`;
  child.stdout.on("data", (buf) => process.stdout.write(prefixLines(prefix, buf)));
  child.stderr.on("data", (buf) => process.stderr.write(prefixLines(prefix, buf)));
  child.on("exit", (code, signal) => {
    console.log(`${prefix} exited (code=${code} signal=${signal ?? "-"})`);
    void shutdown(code ?? 1);
  });
  children.push({ name, child });
  return child;
}

function prefixLines(prefix, buf) {
  return buf.toString("utf8").replace(/^/gm, `${prefix} `).replace(/\n\[.*?\] $/, "\n");
}

async function waitForSocket(path, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (existsSync(path)) return true;
    await sleep(100);
  }
  return false;
}

async function waitForHttp(url, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await sleep(150);
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
  const graceUntil = Date.now() + 3000;
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

launch("runner", [join(HERE, "runner.mjs")], {}, "35");

const runnerReady = await waitForSocket(RUNNER_SOCKET, 10_000);
if (!runnerReady) {
  console.error(`runner socket did not appear at ${RUNNER_SOCKET} within 10s`);
  await shutdown(1);
}

launch(
  "gateway",
  [join(HERE, "gateway.mjs")],
  {
    MIX_RUNNER_SOCKET: RUNNER_SOCKET,
    MIX_RUNNER_TOKEN_PATH: RUNNER_TOKEN_PATH,
    MIX_WEB_DIST: WEB_DIST,
    PORT,
  },
  "33",
);

const url = `http://127.0.0.1:${PORT}/`;
const gatewayReady = await waitForHttp(`${url}health`, 15_000);
if (!gatewayReady) {
  console.error(`gateway did not become healthy at ${url} within 15s`);
  await shutdown(1);
}

console.log(`MCP Inspector X ready at ${url}`);
if (!process.env.MIX_NO_OPEN) {
  const opener = platform() === "darwin" ? "open" : platform() === "win32" ? "start" : "xdg-open";
  execFile(opener, [url], () => {});
}
