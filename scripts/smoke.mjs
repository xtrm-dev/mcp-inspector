#!/usr/bin/env node
// End-to-end smoke test against the PACKAGED product (not source): builds
// the tarball, extracts it into a scratch dir, `npm install`s it exactly as
// a real `npx @xtrm-dev/mcp-inspector-x` consumer would, boots the
// supervisor from the extracted package, hits a scenario suite over real
// HTTP, then tears everything down.
//
// Signal-handled: SIGINT/SIGTERM (and any scenario failure) run the same
// teardown path so the supervisor + its runner/gateway children never leak.
// Scenarios are a plain array of {name, run(ctx)} — new ones can be
// appended without touching the harness (scenario-plugin shape requested by
// the bead: post-integration scenarios add to SCENARIOS, nothing else).

import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = join(import.meta.dirname, "..");
const REBUILD = process.env.SKIP_PACKAGE !== "1";
const PORT = Number(process.env.SMOKE_PORT ?? 16275);
const BASE_URL = `http://127.0.0.1:${PORT}`;

let supervisor = null;
let scratchDir = null;

// ---- scenario plugins -----------------------------------------------------

const SCENARIOS = [
  {
    name: "health",
    async run(ctx) {
      const res = await ctx.get("/health");
      ctx.assert(res.status === "ok", `unexpected health payload: ${JSON.stringify(res)}`);
    },
  },
  {
    name: "add server (second binding to the demo MCP endpoint)",
    async run(ctx) {
      const { servers } = await ctx.get("/api/v1/servers");
      const demo = servers.find((s) => s.id === "demo");
      ctx.assert(demo, "expected built-in 'demo' server to be seeded");
      const created = await ctx.post("/api/v1/servers", {
        displayName: "Smoke second binding",
        transport: "streamable-http",
        endpoint: demo.endpoint,
        connectNow: true,
      });
      ctx.assert(created.connected === true, `expected new server to connect: ${JSON.stringify(created)}`);
      ctx.state.secondServerId = created.server.id;
    },
  },
  {
    name: "tool call (add_numbers on the demo server)",
    async run(ctx) {
      const result = await ctx.post("/api/v1/servers/demo/tools/add_numbers/call", {
        arguments: { a: 19, b: 23 },
      });
      ctx.assert(result.value?.sum === 42, `expected sum=42, got ${JSON.stringify(result)}`);
      ctx.state.executionId = result.executionId;
    },
  },
  {
    name: "workspace run (create workspace + node, run it, verify the result)",
    async run(ctx) {
      const { workspace } = await ctx.post("/api/v1/workspaces", { name: "smoke workspace" });
      const { node } = await ctx.post(`/api/v1/workspaces/${workspace.id}/nodes`, {
        serverId: "demo",
        capabilityId: "demo::tool::add_numbers",
        argumentsJson: JSON.stringify({ a: 5, b: 7 }),
      });
      const run = await ctx.post(`/api/v1/workspaces/${workspace.id}/run`, {});
      const result = run.nodes?.find((r) => r.nodeId === node.id);
      ctx.assert(result?.ok === true, `expected node run to succeed: ${JSON.stringify(run)}`);
      const { rounds } = await ctx.get(`/api/v1/executions/${result.executionId}`);
      const sum = JSON.parse(rounds[0].resultInlineJson).sum;
      ctx.assert(sum === 12, `expected workspace-run sum=12, got ${JSON.stringify(rounds[0])}`);
    },
  },
  {
    name: "packet export (build an Investigation Packet from the tool-call execution)",
    async run(ctx) {
      ctx.assert(ctx.state.executionId, "no executionId captured from the tool-call scenario");
      const { packet } = await ctx.post("/api/v1/packets/build", {
        executionIds: [ctx.state.executionId],
        tier: "investigation",
        format: "json",
      });
      ctx.assert(packet && Array.isArray(packet.executions) && packet.executions.length === 1, `expected a 1-execution packet: ${JSON.stringify(packet)}`);
    },
  },
  {
    // PRD §36 Scenario D — History/comparison. Runs add_numbers a second
    // time with different arguments and compares the two executions via the
    // domain-level /executions/compare route.
    name: "history/comparison (compare two add_numbers executions)",
    async run(ctx) {
      ctx.assert(ctx.state.executionId, "no first-run executionId captured");
      const second = await ctx.post("/api/v1/servers/demo/tools/add_numbers/call", {
        arguments: { a: 100, b: 1 },
      });
      ctx.assert(second.value?.sum === 101, `expected sum=101, got ${JSON.stringify(second)}`);
      const cmp = await ctx.post("/api/v1/executions/compare", {
        leftId: ctx.state.executionId,
        rightId: second.executionId,
      });
      ctx.assert(cmp && (cmp.left || cmp.leftExecution) && (cmp.right || cmp.rightExecution),
        `expected compare result with left/right sides, got ${JSON.stringify(cmp)}`);
    },
  },
  {
    // PRD §36 Scenario B — Modern interactive execution (MRTR). Uses the
    // packaged demo tool `interactive_greet` to round-trip input_required →
    // input_response under ONE executionId via POST /executions/:id/rounds.
    name: "MRTR round (interactive_greet: input_required → input_response, same executionId)",
    async run(ctx) {
      const initial = await ctx.post("/api/v1/servers/demo/tools/interactive_greet/call", {
        arguments: {},
      });
      ctx.assert(initial.status === "input_required",
        `expected initial status=input_required, got ${JSON.stringify(initial)}`);
      ctx.assert(initial.inputRequests && Object.keys(initial.inputRequests).length > 0,
        `expected inputRequests on the initial round: ${JSON.stringify(initial)}`);
      const round2 = await ctx.post(`/api/v1/executions/${initial.executionId}/rounds`, {
        inputResponses: { name: { action: "accept", content: { name: "world" } } },
      });
      ctx.assert(round2.status === "complete",
        `expected round-2 status=complete, got ${JSON.stringify(round2)}`);
      ctx.assert(round2.executionId === initial.executionId,
        `expected same executionId across rounds, got ${round2.executionId} vs ${initial.executionId}`);
      const { rounds } = await ctx.get(`/api/v1/executions/${initial.executionId}`);
      ctx.assert(rounds.length >= 2,
        `expected >=2 rounds under one execution, got ${rounds.length}`);
    },
  },
  {
    // PRD §36 Scenario C — Task-backed operation (domain-layer). Uses the
    // packaged demo tool `long_running_task` which advertises the tasks
    // extension and rides polling as taskAction rounds under ONE
    // executionId. Note: R1 (mcp-inspector-4to) will convert this to real
    // wire-level tasks/get once the SDK gap is closed.
    name: "Tasks lifecycle (long_running_task: create → poll → complete under one executionId)",
    async run(ctx) {
      const initial = await ctx.post("/api/v1/servers/demo/tools/long_running_task/call", {
        arguments: {},
      });
      ctx.assert(initial.status === "task_working",
        `expected initial status=task_working, got ${JSON.stringify(initial)}`);
      ctx.assert(typeof initial.value?.taskId === "string",
        `expected a taskId in the initial value, got ${JSON.stringify(initial.value)}`);

      let terminal = null;
      let nextDelayMs = 150;
      for (let i = 0; i < 8; i += 1) {
        const poll = await ctx.post(`/api/v1/executions/${initial.executionId}/rounds`, {
          taskAction: "poll",
        });
        ctx.assert(poll.executionId === initial.executionId,
          `expected polls to stay under one executionId, got ${poll.executionId}`);
        if (poll.status === "complete") {
          terminal = poll;
          break;
        }
        ctx.assert(poll.status === "task_working",
          `unexpected intermediate status ${poll.status}: ${JSON.stringify(poll)}`);
        // R1.3: honor the server-advertised pollIntervalMs the gateway
        // surfaced from tasks/get; clamped to a safe [50, 5000] window.
        const advertised = poll?.evidence?.extensions?.pollIntervalMs;
        nextDelayMs = typeof advertised === "number"
          ? Math.min(5000, Math.max(50, advertised))
          : 150;
        await sleep(nextDelayMs);
      }
      ctx.assert(terminal && terminal.status === "complete",
        `task did not reach complete within budget: ${JSON.stringify(terminal)}`);
      ctx.assert(typeof terminal.value?.result === "number",
        `expected numeric task result, got ${JSON.stringify(terminal.value)}`);
    },
  },
  {
    // PRD §36 Scenario C (cancel branch) — cancel a task-backed operation
    // before it completes, verify the execution transitions to cancelled.
    name: "Tasks cancel (long_running_task: create → cancel mid-run)",
    async run(ctx) {
      const initial = await ctx.post("/api/v1/servers/demo/tools/long_running_task/call", {
        arguments: {},
      });
      ctx.assert(initial.status === "task_working",
        `expected initial status=task_working, got ${JSON.stringify(initial)}`);
      const cancelled = await ctx.post(`/api/v1/executions/${initial.executionId}/rounds`, {
        taskAction: "cancel",
      });
      ctx.assert(cancelled.status === "cancelled",
        `expected status=cancelled, got ${JSON.stringify(cancelled)}`);
      const detail = await ctx.get(`/api/v1/executions/${initial.executionId}`);
      ctx.assert(detail.execution.status === "cancelled",
        `expected persisted execution status=cancelled, got ${JSON.stringify(detail.execution)}`);
    },
  },
  {
    // Runner wiring proof (bug mcp-inspector-68e). The packaged gateway
    // must connect to the supervisor-spawned runner over its UDS and pass
    // the client into buildGatewayApp/createServerManager. Opening a
    // stdio-proxy capture session touches BOTH ends of that wiring
    // (deps.runnerClient in routes.ts + runner.attachCaptureSession) and
    // will fail fast with "requires a privileged runner" if the boot
    // regresses again. Also verifies the session enters storage and can
    // be closed cleanly.
    name: "runner wiring (stdio-proxy capture session open + list + close)",
    async run(ctx) {
      const opened = await ctx.post("/api/v1/capture-sessions/stdio-proxy/open", {
        note: "smoke-runner-wiring",
      });
      ctx.assert(opened.captureSession?.id,
        `expected captureSession.id, got ${JSON.stringify(opened)}`);
      const captureId = opened.captureSession.id;
      const list = await ctx.get("/api/v1/capture-sessions");
      ctx.assert(Array.isArray(list.captureSessions) &&
        list.captureSessions.some((s) => s.id === captureId),
        `capture session not visible in list, got ${JSON.stringify(list)}`);
      const closed = await ctx.post(`/api/v1/capture-sessions/${captureId}/close`, {});
      ctx.assert(closed.captureSession?.endedAt,
        `expected endedAt on closed capture session, got ${JSON.stringify(closed)}`);
    },
  },
  {
    name: "web UI reachable (packaged SPA served by the gateway)",
    async run(ctx) {
      const res = await fetch(`${BASE_URL}/`);
      const body = await res.text();
      ctx.assert(res.ok, `GET / failed with status ${res.status}`);
      ctx.assert(body.includes("MCP Inspector X"), "index.html missing expected title");
    },
  },
];

// ---- harness ----------------------------------------------------------------

function log(...args) {
  console.log("[smoke]", ...args);
}

function run(cmd, args, opts = {}) {
  log(`+ ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { stdio: "inherit", ...opts });
}

async function waitForHealth(timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${BASE_URL}/health`);
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await sleep(200);
  }
  return false;
}

async function teardown(exitCode) {
  if (teardown.done) return;
  teardown.done = true;
  if (supervisor && supervisor.exitCode === null) {
    log("stopping supervisor…");
    try {
      supervisor.kill("SIGTERM");
    } catch {
      // already gone
    }
    const graceUntil = Date.now() + 3000;
    while (supervisor.exitCode === null && Date.now() < graceUntil) await sleep(50);
    if (supervisor.exitCode === null) {
      log("supervisor did not exit in time — SIGKILLing process group");
      try {
        process.kill(-supervisor.pid, "SIGKILL");
      } catch {
        try {
          supervisor.kill("SIGKILL");
        } catch {
          // nothing left to kill
        }
      }
    }
  }
  if (scratchDir && existsSync(scratchDir)) {
    rmSync(scratchDir, { recursive: true, force: true });
  }
  process.exit(exitCode);
}

process.on("SIGINT", () => void teardown(130));
process.on("SIGTERM", () => void teardown(143));

async function main() {
  if (REBUILD) {
    run("node", [join(ROOT, "scripts/package.mjs")]);
  }
  const infoPath = join(ROOT, "dist-package/package-info.json");
  if (!existsSync(infoPath)) {
    throw new Error("dist-package/package-info.json missing — run `npm run package` first or unset SKIP_PACKAGE");
  }
  const { tarball } = JSON.parse(readFileSync(infoPath, "utf8"));
  const tarballPath = join(ROOT, "dist-package", tarball);

  scratchDir = mkdtempSync(join(tmpdir(), "mix-smoke-"));
  const extractDir = join(scratchDir, "extract");
  const dataDir = join(scratchDir, "data");
  mkdirSync(extractDir, { recursive: true });

  log(`extracting ${tarball} → ${extractDir}`);
  run("tar", ["xzf", tarballPath, "-C", extractDir]);
  const pkgDir = join(extractDir, "package");

  log("npm install --omit=dev (resolves the native better-sqlite3 binary, as a real consumer would)");
  run("npm", ["install", "--omit=dev"], { cwd: pkgDir });

  log("starting packaged supervisor…");
  supervisor = spawn(process.execPath, [join(pkgDir, "bin.mjs")], {
    cwd: pkgDir,
    detached: true,
    stdio: ["ignore", "inherit", "inherit"],
    env: {
      ...process.env,
      MIX_DATA_DIR: dataDir,
      PORT: String(PORT),
      MIX_NO_OPEN: "1",
    },
  });
  supervisor.on("exit", (code, signal) => {
    if (!teardown.done) {
      log(`supervisor exited unexpectedly (code=${code} signal=${signal ?? "-"})`);
    }
  });

  const healthy = await waitForHealth(20_000);
  if (!healthy) throw new Error(`packaged supervisor never became healthy at ${BASE_URL}/health`);

  const ctx = {
    state: {},
    assert(cond, msg) {
      if (!cond) throw new Error(msg);
    },
    async get(path) {
      const res = await fetch(`${BASE_URL}${path}`);
      const body = await res.json();
      if (!res.ok) throw new Error(`GET ${path} → ${res.status}: ${JSON.stringify(body)}`);
      return body;
    },
    async post(path, body) {
      const res = await fetch(`${BASE_URL}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(`POST ${path} → ${res.status}: ${JSON.stringify(json)}`);
      return json;
    },
  };

  let failures = 0;
  for (const scenario of SCENARIOS) {
    try {
      await scenario.run(ctx);
      log(`PASS  ${scenario.name}`);
    } catch (err) {
      failures += 1;
      log(`FAIL  ${scenario.name}: ${err.message}`);
    }
  }

  log(`${SCENARIOS.length - failures}/${SCENARIOS.length} scenarios passed`);
  await teardown(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("[smoke] FATAL:", err);
  await teardown(1);
});
