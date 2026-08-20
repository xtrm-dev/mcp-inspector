#!/usr/bin/env node
// Root-level `bin` entry so `npx @xtrm-dev/mcp-inspector-x` and local
// `npm exec mcp-inspector-x` resolve to something. The real, published
// artifact is the packaged tarball built by scripts/package.mjs (its own
// package.json carries the same bin name pointing at scripts/package-bin.mjs
// alongside the bundled runner/gateway/web). In a source checkout, delegate
// to the already-built package if present, otherwise point the user at
// `npm run package`.
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const staged = join(ROOT, "dist-package/stage/bin.mjs");

if (!existsSync(staged)) {
  console.error("No packaged build found. Run `npm run package` first, then re-run this command.");
  process.exit(1);
}

const child = spawn(process.execPath, [staged, ...process.argv.slice(2)], { stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 0));
