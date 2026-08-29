#!/usr/bin/env node
// mix-vd1 smoke assertion — rendered-UI check for the workspace-card collapse
// fix (header Collapse affordance + Escape handler + "Exit focus" -> collapsed).
//
// Runs against ANY running supervisor (packaged or dev-vite) that serves the
// web app + /api/v1. It builds its OWN scratch workspace over the API (≥2
// expanded cards), renders the Grid at a laptop viewport, and asserts:
//   1. every expanded card's collapse button lives in the card HEADER
//      (`.capability-card-head`) — so it stays above the fold at 1024x600;
//   2. every card whose top is visible in `.canvas-scroll` at scrollTop 0 has
//      its collapse button inside the canvas client rect;
//   3. Escape collapses a focused node via the node PATCH endpoint and unmounts
//      the focus overlay.
// The scratch workspace is deleted on the way out.
//
// Usage:
//   node scripts/smoke-collapse-visible.mjs [BASE_URL]
// Env:
//   BASE_URL            supervisor root (default http://127.0.0.1:6276)
//   SMOKE_VIEWPORT      "WxH" (default 1024x600)
//   CHROMIUM_PATH       explicit chrome/headless-shell binary
// Requires `playwright-core` (or `playwright`) resolvable at runtime; e.g.
//   npm i -D playwright-core && npx playwright install chromium

import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE_URL = (process.env.BASE_URL ?? process.argv[2] ?? "http://127.0.0.1:6276").replace(/\/$/, "");
const [VIEW_W, VIEW_H] = (process.env.SMOKE_VIEWPORT ?? "1024x600").split("x").map(Number);

function fail(reason) {
  console.error(`FAIL: ${reason}`);
  process.exitCode = 1;
}

const req = createRequire(import.meta.url);
function loadChromium() {
  for (const mod of ["playwright-core", "playwright"]) {
    try {
      const { chromium } = req(mod);
      if (chromium) return chromium;
    } catch {
      /* try next */
    }
  }
  return null;
}

function findChromiumBinary() {
  if (process.env.CHROMIUM_PATH && fs.existsSync(process.env.CHROMIUM_PATH)) {
    return process.env.CHROMIUM_PATH;
  }
  const cacheRoot = path.join(os.homedir(), ".cache", "ms-playwright");
  if (!fs.existsSync(cacheRoot)) return null;
  const candidates = fs.readdirSync(cacheRoot).sort().reverse();
  for (const dir of candidates) {
    for (const rel of ["chrome-linux64/chrome", "chrome-headless-shell-linux64/chrome-headless-shell"]) {
      const bin = path.join(cacheRoot, dir, rel);
      if (fs.existsSync(bin)) return bin;
    }
  }
  return null;
}

async function api(pathname, init) {
  const res = await fetch(`${BASE_URL}${pathname}`, init);
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) {
    throw new Error(`${init?.method ?? "GET"} ${pathname} -> ${res.status}: ${text.slice(0, 200)}`);
  }
  return body;
}

async function main() {
  const checks = [];
  const chromium = loadChromium();
  if (!chromium) {
    console.error("SKIP: neither playwright-core nor playwright is resolvable.");
    console.error("  npm i -D playwright-core && npx playwright install chromium");
    process.exit(3);
  }
  const exe = findChromiumBinary();
  const launchArgs = { headless: true, args: ["--no-sandbox", "--disable-gpu"] };
  if (exe) launchArgs.executablePath = exe;
  const browser = await chromium.launch(launchArgs);
  const page = await browser.newPage({ viewport: { width: VIEW_W, height: VIEW_H } });

  let scratchWorkspaceId = null;
  const patchEvents = [];
  page.on("request", (r) => {
    if (r.method() === "PATCH" && r.url().includes("/api/v1/workspaces/")) {
      patchEvents.push({ url: r.url(), body: r.postData() ?? "" });
    }
  });

  try {
    // ---- seed a hermetic workspace: 2 expanded grid cards on the demo server
    const { servers } = await api("/api/v1/servers");
    const demo = servers.find((s) => s.id === "demo") ?? servers[0];
    if (!demo) throw new Error("no server available to bind workspace nodes");
    let toolNames = [];
    try {
      const tools = await api(`/api/v1/servers/${encodeURIComponent(demo.id)}/tools`);
      toolNames = (tools.tools ?? []).slice(0, 2).map((t) => t.name);
    } catch {
      /* demo may expose a broken surface; fall back to known demo tools */
    }
    const fallbackTools = ["add_numbers", "echo", "get_weather"];
    while (toolNames.length < 2 && fallbackTools.length) {
      const t = fallbackTools.shift();
      if (!toolNames.includes(t)) toolNames.push(t);
    }

    const { workspace } = await api("/api/v1/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: `mix-vd1-smoke-${Date.now()}` }),
    });
    scratchWorkspaceId = workspace.id;
    await api(`/api/v1/workspaces/${workspace.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ layoutJson: JSON.stringify({ projection: "grid", selectedNodeIds: [] }) }),
    });
    const nodeIds = [];
    for (let i = 0; i < toolNames.length; i++) {
      const { node } = await api(`/api/v1/workspaces/${workspace.id}/nodes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          serverId: demo.id,
          capabilityId: `${demo.id}::tool::${toolNames[i]}`,
          presentation: "expanded",
          position: i,
        }),
      });
      nodeIds.push(node.id);
    }
    if (nodeIds.length < 2) throw new Error("need >=2 nodes to reproduce the operator scenario");

    // ---- render the grid at laptop viewport (select the scratch workspace)
    async function pickScratchWorkspace() {
      await page.waitForSelector('.workspace-picker select', { timeout: 30000 });
      const options = await page.evaluate(() =>
        [...document.querySelectorAll('.workspace-picker select option')].map((o) => ({ value: o.value, text: o.textContent.trim() })),
      );
      const scratchName = workspace.name;
      const opt = options.find((o) => o.text === scratchName);
      if (!opt) throw new Error(`scratch workspace not in picker: ${JSON.stringify(options)}`);
      await page.selectOption('.workspace-picker select', opt.value);
    }
    await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
    await pickScratchWorkspace();
    await page.waitForFunction(
      (ids) => ids.every((id) => document.querySelector(`[data-testid="capability-card-${id}"]`)),
      nodeIds,
      { timeout: 30000 },
    );
    await page.waitForTimeout(800);

    const layout = await page.evaluate(() => {
      const canvas = document.querySelector(".canvas-scroll");
      const canvasRect = canvas?.getBoundingClientRect() ?? null;
      const cards = [...document.querySelectorAll('[data-testid^="capability-card-"]')]
        .filter((c) => !c.closest('.detail-pane') && !c.closest('.capability-focus')) // grid copies only
        .map((c) => {
          const cardRect = c.getBoundingClientRect();
          const collapseBtn = c.querySelector('[data-testid^="collapse-"]');
          const inHeader = !!(collapseBtn && c.querySelector(".capability-card-head")?.contains(collapseBtn));
          let btnInsideCanvas = null;
          if (collapseBtn && canvasRect) {
            const br = collapseBtn.getBoundingClientRect();
            btnInsideCanvas =
              br.y >= canvasRect.top && br.y + br.height <= canvasRect.bottom &&
              br.x >= canvasRect.left && br.x + br.width <= canvasRect.right;
          }
          return {
            id: c.dataset.testid.replace("capability-card-", "").slice(0, 8),
            cardTop: cardRect.top,
            cardBottom: cardRect.bottom,
            inHeader,
            btnInsideCanvas,
          };
        });
      return { canvasTop: canvasRect?.top ?? null, canvasBottom: canvasRect?.bottom ?? null, cards };
    });

    // A1: every expanded card has its Collapse affordance in the header
    const allInHeader = layout.cards.every((c) => c.inHeader);
    checks.push(["A1 header Collapse affordance", allInHeader]);
    console.log(`A1: ${layout.cards.length} grid cards; all collapse buttons in .capability-card-head -> ${allInHeader}`);

    // A2: any card visible in the canvas at scrollTop 0 must show its collapse button inside the canvas
    const visible = layout.cards.filter((c) => c.cardTop < (layout.canvasBottom ?? Infinity) && c.cardBottom > (layout.canvasTop ?? -Infinity));
    const visibleOk = visible.every((c) => c.btnInsideCanvas === true);
    checks.push(["A2 collapse buttons inside canvas rect at 1024x600", visibleOk]);
    console.log(`A2: ${visible.length}/${layout.cards.length} cards visible at scrollTop 0; their collapse buttons inside canvas -> ${visibleOk}`);

    // A3: Escape collapses a focused node via PATCH and unmounts the overlay.
    // Focus the node through the API, then refetch the workspace by switching
    // the picker away and back (avoids a full page reload, which chokes the
    // vite dev server with ERR_INSUFFICIENT_RESOURCES on this host).
    await api(`/api/v1/workspaces/${workspace.id}/nodes/${nodeIds[0]}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ presentation: "focus" }),
    });
    const otherOption = await page.evaluate((scratchName) => {
      const opts = [...document.querySelectorAll('.workspace-picker select option')];
      const other = opts.find((o) => o.textContent.trim() !== scratchName);
      const scratchValue = opts.find((o) => o.textContent.trim() === scratchName)?.value;
      return { otherValue: other?.value ?? null, scratchValue: scratchValue ?? null };
    }, workspace.name);
    if (otherOption.otherValue && otherOption.scratchValue) {
      await page.selectOption('.workspace-picker select', otherOption.otherValue);
      await page.waitForTimeout(600);
      await page.selectOption('.workspace-picker select', otherOption.scratchValue);
    }
    await page.waitForFunction(
      (id) => document.querySelector(`[data-testid="capability-focus-${id}"]`),
      nodeIds[0],
      { timeout: 30000 },
    );
    await page.keyboard.press("Escape");
    await page.waitForTimeout(900);
    const overlayGone = await page
      .waitForSelector('[data-testid^="capability-focus-"]', { state: "detached", timeout: 3000 })
      .then(() => true)
      .catch(() => false);
    let escBody = null;
    let escNode = null;
    try {
      const res = await api(`/api/v1/workspaces/${workspace.id}`);
      escNode = (res.nodes ?? []).find((n) => n.id === nodeIds[0])?.presentation ?? null;
      escBody = patchEvents.find((e) => e.url.includes(nodeIds[0]))?.body ?? null;
    } catch { /* cleanup path */ }
    const escOk = escNode === "collapsed" && escBody != null && escBody.includes('"collapsed"') && overlayGone;
    checks.push(["A3 Escape collapses focused node via PATCH", escOk]);
    console.log(`A3: after Escape overlay detached=${overlayGone}, node=${escNode}, PATCH body=${escBody} -> ${escOk}`);
  } finally {
    if (scratchWorkspaceId) {
      await api(`/api/v1/workspaces/${scratchWorkspaceId}`, { method: "DELETE" }).catch(() => {});
    }
    await browser.close();
  }

  const failed = checks.filter(([, ok]) => !ok);
  if (failed.length > 0) {
    for (const [name] of failed) fail(`${name} failed`);
    console.error(`\nsmoke-collapse-visible: ${checks.length - failed.length}/${checks.length} checks passed`);
    process.exitCode = 1;
  } else {
    console.log(`\nsmoke-collapse-visible: ALL ${checks.length} checks passed against ${BASE_URL}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  fail(err instanceof Error ? err.message : String(err));
});
