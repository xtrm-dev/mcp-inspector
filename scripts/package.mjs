#!/usr/bin/env node
// Builds the distributable npm package: bundles runner + gateway +
// conformance-client to single-file JS (esbuild), builds the web SPA (real
// `vite build`), stages a self-contained package directory, `npm pack`s it,
// and writes a sha256 checksum next to the tarball.
//
// ponytail: esbuild is already a transitive dep (vite pulls it in) — no new
// dependency added for bundling. better-sqlite3 is the one native addon in
// the dependency graph and stays external: npm resolves/installs the
// prebuilt binary for the target platform when the packed tarball itself is
// installed, same as any other npm package with a native dependency.

import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, cpSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT_DIR = join(ROOT, "dist-package");
const STAGE = join(OUT_DIR, "stage");

const rootPkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const storagePkg = JSON.parse(readFileSync(join(ROOT, "packages/storage/package.json"), "utf8"));

function run(cmd, args) {
  console.log(`+ ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { stdio: "inherit", cwd: ROOT });
}

async function bundle(entry, outfile) {
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    external: ["better-sqlite3"],
    sourcemap: true,
    logLevel: "info",
  });
}

async function main() {
  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(STAGE, { recursive: true });

  // 1. Web assets — real production build (minified, hashed filenames).
  run("npm", ["run", "build", "--workspace", "@mcp-inspector-x/web"]);
  cpSync(join(ROOT, "apps/web/dist"), join(STAGE, "web"), { recursive: true });

  // 2. Bundle runner + gateway + conformance-client to single files.
  await bundle(join(ROOT, "packages/runner/src/main.ts"), join(STAGE, "runner.mjs"));
  await bundle(join(ROOT, "apps/gateway/src/index.ts"), join(STAGE, "gateway.mjs"));
  await bundle(
    join(ROOT, "apps/conformance-client/src/index.ts"),
    join(STAGE, "conformance-client.mjs"),
  );

  // 3. Supervisor launcher (bin entry).
  cpSync(join(ROOT, "scripts/package-bin.mjs"), join(STAGE, "bin.mjs"));
  chmodSync(join(STAGE, "bin.mjs"), 0o755);

  // 4. Staged package.json — only the real runtime deps the bundle could not
  //    inline (the native addon), plus the bin entry `npx` resolves.
  const version = rootPkg.version && rootPkg.version !== "0.0.0" ? rootPkg.version : "1.0.0-v1";
  const staged = {
    name: rootPkg.name,
    version,
    description: "MCP Inspector X — local MCP inspector (packaged)",
    type: "module",
    bin: { "mcp-inspector-x": "./bin.mjs" },
    engines: rootPkg.engines,
    dependencies: {
      "better-sqlite3": storagePkg.dependencies["better-sqlite3"],
    },
    files: [
      "runner.mjs",
      "runner.mjs.map",
      "gateway.mjs",
      "gateway.mjs.map",
      "conformance-client.mjs",
      "conformance-client.mjs.map",
      "bin.mjs",
      "web/**",
    ],
  };
  writeFileSync(join(STAGE, "package.json"), `${JSON.stringify(staged, null, 2)}\n`);
  writeFileSync(
    join(STAGE, "README.md"),
    "# @xtrm-dev/mcp-inspector-x (packaged)\n\nRun `npx @xtrm-dev/mcp-inspector-x@latest`. See the project README for details.\n",
  );

  // 5. npm pack -> tarball + checksum.
  const packOut = execFileSync("npm", ["pack", "--json", `--pack-destination=${OUT_DIR}`], {
    cwd: STAGE,
  }).toString();
  const [meta] = JSON.parse(packOut);
  const tarballPath = join(OUT_DIR, meta.filename);
  const checksum = createHash("sha256").update(readFileSync(tarballPath)).digest("hex");
  writeFileSync(`${tarballPath}.sha256`, `${checksum}  ${meta.filename}\n`);
  writeFileSync(
    join(OUT_DIR, "package-info.json"),
    `${JSON.stringify(
      {
        tarball: meta.filename,
        sha256: checksum,
        sizeBytes: meta.size,
        version,
        builtAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );

  console.log(`\nPackaged: ${tarballPath}`);
  console.log(`sha256: ${checksum}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
