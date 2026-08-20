#!/usr/bin/env -S node --enable-source-maps
// Runner entrypoint. Boots a listening socket and (unless already provided
// via MIX_RUNNER_TOKEN) generates a fresh token written to
// $MIX_DATA_DIR/runner.token so a co-located gateway can connect.

import { homedir } from "node:os";
import { join } from "node:path";
import { startRunnerServer, generateAuthToken, RUNNER_VERSION } from "./server";

function dataDir(): string {
  return process.env["MIX_DATA_DIR"] ?? join(homedir(), ".mcp-inspector-x");
}

async function main(): Promise<void> {
  const dir = dataDir();
  const socketPath = process.env["MIX_RUNNER_SOCKET"] ?? join(dir, "runner.sock");
  const tokenPath = process.env["MIX_RUNNER_TOKEN_PATH"] ?? join(dir, "runner.token");
  const token = process.env["MIX_RUNNER_TOKEN"] ?? generateAuthToken();

  const handle = await startRunnerServer({ socketPath, token, tokenPath });
  console.log(
    `mcp-inspector-x runner v${RUNNER_VERSION} listening on ${handle.socketPath} (token at ${tokenPath})`,
  );

  const shutdown = () => {
    handle.close().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main().catch((err) => {
  console.error("runner boot failed:", err);
  process.exit(1);
});
