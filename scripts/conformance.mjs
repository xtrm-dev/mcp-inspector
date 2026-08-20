#!/usr/bin/env node
// Runs the official @modelcontextprotocol/conformance harness against the
// PACKAGED conformance client binary (dist-package/stage/conformance-client.mjs,
// bundled by scripts/package.mjs — not `tsx src/index.ts`), and writes the
// evidence artifact required by PRD §37 to conformance/evidence/v1-<date>.json.
//
// Two runs:
//   - required:    `tools_call` at --spec-version 2026-07-28. Must pass —
//                   this script exits 1 if it doesn't. Mirrors the required
//                   job in .github/workflows/conformance.yml.
//   - informational: the full `--requirements 2026-07-28` sweep. Best-effort,
//                   never fails this script — auth/DPoP/etc. scenarios are
//                   expected to fail because no OAuthProvider is wired at
//                   this slice (see apps/conformance-client/expected-failures.yml
//                   for the itemized baseline). Mirrors the scoreboard job.
//
// ponytail: no new dependency — `npx --package=@modelcontextprotocol/conformance`
// is how CI already invokes the harness.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const HARNESS = "@modelcontextprotocol/conformance@0.2.0-alpha.11";
const SPEC_VERSION = "2026-07-28";
const CLIENT_BIN = join(ROOT, "dist-package/stage/conformance-client.mjs");
const INFO_PATH = join(ROOT, "dist-package/package-info.json");

function log(...args) {
  console.log("[conformance]", ...args);
}

function run(args) {
  log(`+ npx --yes --package=${HARNESS} conformance ${args.join(" ")}`);
  try {
    return execFileSync(
      "npx",
      ["--yes", `--package=${HARNESS}`, "conformance", ...args],
      { cwd: ROOT, encoding: "utf8" },
    );
  } catch (err) {
    // The harness exits non-zero when scored checks fail — callers decide
    // whether that's fatal. Return the captured output either way.
    return err.stdout ?? String(err);
  }
}

function readChecks(outputDir) {
  const entries = readdirSync(outputDir, { withFileTypes: true }).filter((e) => e.isDirectory());
  const checks = [];
  for (const entry of entries) {
    const checksPath = join(outputDir, entry.name, "checks.json");
    if (existsSync(checksPath)) checks.push(...JSON.parse(readFileSync(checksPath, "utf8")));
  }
  return checks;
}

async function main() {
  if (!existsSync(CLIENT_BIN)) {
    log("no packaged conformance-client found — building the package first");
    execFileSync("node", [join(ROOT, "scripts/package.mjs")], { stdio: "inherit", cwd: ROOT });
  }
  if (!existsSync(INFO_PATH)) throw new Error("dist-package/package-info.json missing after package build");
  const packageInfo = JSON.parse(readFileSync(INFO_PATH, "utf8"));

  const scratch = mkdtempSync(join(tmpdir(), "mix-conformance-"));
  const requiredDir = join(scratch, "required");
  mkdirSync(requiredDir, { recursive: true });

  const requiredOut = run([
    "client",
    "--command",
    `node ${CLIENT_BIN}`,
    "--scenario",
    "tools_call",
    "--spec-version",
    SPEC_VERSION,
    "--timeout",
    "15000",
    "--output-dir",
    requiredDir,
  ]);
  console.log(requiredOut);
  const requiredChecks = readChecks(requiredDir);
  const requiredPassed = requiredChecks.length > 0 && requiredChecks.every((c) => c.status === "SUCCESS");

  const infoDir = join(scratch, "informational");
  mkdirSync(infoDir, { recursive: true });
  const infoOut = run([
    "client",
    "--command",
    `node ${CLIENT_BIN}`,
    "--requirements",
    SPEC_VERSION,
    "--timeout",
    "15000",
    "--output-dir",
    infoDir,
  ]);
  console.log(infoOut);
  const totalsMatch = infoOut.match(/Total:\s*(\d+)\s*passed,\s*(\d+)\s*failed,\s*(\d+)\s*warnings/);

  const evidence = {
    schema: "mcp-inspector-x/conformance-evidence/v1",
    generatedAt: new Date().toISOString(),
    mcpRevision: SPEC_VERSION,
    harness: HARNESS,
    clientUnderTest: "dist-package/stage/conformance-client.mjs (packaged, esbuild-bundled — not source tree)",
    packagedArtifact: {
      tarball: packageInfo.tarball,
      sha256: packageInfo.sha256,
      sizeBytes: packageInfo.sizeBytes,
      version: packageInfo.version,
    },
    negotiatedScope: {
      description:
        "Client-mode conformance against MCP Inspector X's streamable-http SDK adapter. " +
        "`initialize` is not applicable at 2026-07-28 (folded into request-metadata upstream). " +
        "Resources/prompts/tasks/MRTR client scenarios and all OAuth scenarios are not yet " +
        "implemented by apps/conformance-client at this slice — see " +
        "apps/conformance-client/expected-failures.yml for the itemized baseline and " +
        ".github/workflows/conformance.yml for the CI required/scoreboard split this mirrors.",
      required: ["tools_call"],
    },
    required: {
      scenario: "tools_call",
      passed: requiredPassed,
      checks: requiredChecks.map((c) => ({ id: c.id, name: c.name, status: c.status })),
    },
    informational: {
      description: "Full 2026-07-28 requirements sweep, no baseline applied. Non-blocking — auth/DPoP/etc. failures are expected (no OAuthProvider wired yet).",
      summaryLine: totalsMatch ? totalsMatch[0] : "unavailable",
      totals: totalsMatch
        ? { passed: Number(totalsMatch[1]), failed: Number(totalsMatch[2]), warnings: Number(totalsMatch[3]) }
        : null,
    },
  };

  const dateTag = new Date().toISOString().slice(0, 10);
  const outPath = join(ROOT, "conformance/evidence", `v1-${dateTag}.json`);
  mkdirSync(join(ROOT, "conformance/evidence"), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(evidence, null, 2)}\n`);
  log(`evidence written: ${outPath}`);

  if (!requiredPassed) {
    log("REQUIRED scenario 'tools_call' did not pass — failing.");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[conformance] FATAL:", err);
  process.exit(1);
});
