/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSdkAdapter } from "@mcp-inspector-x/protocol";
import { openStorage, type Storage } from "@mcp-inspector-x/storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildGatewayApp } from "../../gateway/src/routes";
import { createSecretsRegistry } from "../../gateway/src/secrets";
import { createServerManager } from "../../gateway/src/servers";
import { App } from "../src/app";

let container: HTMLDivElement;
let root: Root;
let storage: Storage;
let dataDir: string;
let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "mix-web-cards-"));
  storage = openStorage({ dataDir });
  storage.servers.upsertById({
    id: "srv-local",
    displayName: "Local test server",
    transport: "streamable-http",
    endpoint: "http://127.0.0.1:9/mcp",
    protocolPolicy: "modern",
  });
  const workspace = storage.workspaces.create({ id: "ws-cards", name: "Operations" });
  const node = storage.workspaceNodes.create({
    id: "node-echo",
    workspaceId: workspace.id,
    serverId: "srv-local",
    capabilityId: "srv-local::tool::echo",
    argumentsJson: JSON.stringify({ text: "hello" }),
    presentation: "expanded",
  });
  const execution = storage.executions.create({
    id: "exec-echo",
    workspaceId: workspace.id,
    workspaceNodeId: node.id,
    serverId: "srv-local",
    capabilityId: node.capabilityId!,
    status: "complete",
  });
  storage.rounds.append({
    executionId: execution.id,
    roundIndex: 0,
    kind: "initial",
    argumentsJson: node.argumentsJson,
    resultInlineJson: JSON.stringify({ echoed: "hello" }),
    durationMs: 18,
  });

  const adapter = createSdkAdapter();
  const secrets = createSecretsRegistry({ storage });
  const serverManager = createServerManager({ storage, adapter, secrets });
  const gateway = buildGatewayApp({ adapter, storage, serverManager, secrets });
  fetchSpy = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, "http://localhost");
    return gateway.request(`${url.pathname}${url.search}`, init);
  });
  vi.stubGlobal("fetch", fetchSpy);

  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  storage.close();
  rmSync(dataDir, { recursive: true, force: true });
});

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function click(selector: string) {
  const element = container.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`missing ${selector}`);
  act(() => element.click());
}

function pointer(selector: string, type: string, x: number, y: number, modifiers: MouseEventInit = {}) {
  const element = container.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`missing ${selector}`);
  act(() => element.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, ...modifiers })));
}

describe("workspace capability projections", () => {
  it("projects the same selected node in Grid and List and persists presentation", async () => {
    await act(async () => root.render(<App />));
    await flush();
    await flush();

    expect(container.querySelector('[data-testid="workspace-grid"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="capability-card-node-echo"]')?.textContent).toContain("18 ms");
    const tabs = container.querySelector(".local-tabs")?.textContent;
    expect(tabs).toContain("Result");
    expect(tabs).toContain("Parameters");
    expect(tabs).toContain("Protocol");
    expect(tabs).not.toContain("Source");
    expect(tabs).not.toContain("Process");
    expect(tabs).not.toContain("Logs");

    click('[data-testid="inspection-tab-result-node-echo"]');
    click('[data-testid="maximize-result-node-echo"]');
    expect(container.querySelector('[data-testid="result-focus-node-echo"]')).not.toBeNull();
    click('[data-testid="maximize-result-node-echo"]');

    click('[data-testid="select-node-echo"]');
    click('[data-testid="projection-list"]');

    expect(container.querySelector('[data-testid="workspace-list"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="capability-row-node-echo"]')?.textContent).toContain("echo");
    expect(container.querySelector<HTMLInputElement>('[data-testid="select-node-echo"]')?.checked).toBe(true);

    click('[data-testid="run-selected"]');
    await flush();
    await flush();
    const runCall = fetchSpy.mock.calls.find(([input]) => String(input).includes("/api/v1/workspaces/ws-cards/run"));
    expect(JSON.parse((runCall?.[1] as RequestInit).body as string)).toEqual({ nodeIds: ["node-echo"] });

    click('[data-testid="focus-node-echo"]');
    await flush();

    expect(storage.workspaceNodes.get("node-echo")?.presentation).toBe("focus");
    expect(container.querySelector('[data-testid="capability-focus-node-echo"]')).not.toBeNull();
  });

  it("persists the shared Graph selection, snapped positions, viewport, and reset layout", async () => {
    storage.workspaceNodes.create({
      id: "node-clock",
      workspaceId: "ws-cards",
      serverId: "srv-local",
      capabilityId: "srv-local::tool::clock",
      argumentsJson: JSON.stringify({ timezone: "UTC" }),
    });
    storage.workspaces.update("ws-cards", {
      layoutJson: JSON.stringify({
        futureSlice: { keep: true },
        projection: "graph",
        selectedNodeIds: ["node-echo"],
        graph: {
          positions: { "node-echo": { x: 40, y: 60 } },
          viewport: { x: 10, y: 20, scale: 1 },
          groupBy: "server",
        },
      }),
    });

    await act(async () => root.render(<App />));
    await flush();
    await flush();

    expect(container.querySelector('[data-testid="workspace-graph"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="graph-node-node-echo"]')?.textContent).toContain("echo");
    expect(container.querySelector('[data-testid="graph-node-node-clock"]')?.textContent).toContain("clock");
    // Two same-server nodes now derive one sibling edge.
    expect(container.querySelectorAll(".workspace-graph-edge")).toHaveLength(1);

    pointer('[data-testid="graph-node-node-clock"]', "pointerdown", 220, 80, { ctrlKey: true });
    pointer('[data-testid="workspace-graph"]', "pointerup", 220, 80, { ctrlKey: true });
    expect(container.querySelector('[data-testid="workspace-detail-pane"]')?.textContent).toContain("clock");
    expect(container.textContent).toContain("2 selected");

    pointer('[data-testid="graph-node-node-echo"]', "pointerdown", 40, 60);
    pointer('[data-testid="workspace-graph"]', "pointermove", 81, 101);
    pointer('[data-testid="workspace-graph"]', "pointerup", 81, 101);
    await flush();

    const moved = JSON.parse(storage.workspaces.get("ws-cards")!.layoutJson);
    expect(moved.futureSlice).toEqual({ keep: true });
    expect(moved.projection).toBe("graph");
    expect(moved.selectedNodeIds).toEqual(expect.arrayContaining(["node-echo", "node-clock"]));
    expect(moved.graph.positions["node-echo"]).toEqual({ x: 80, y: 100 });

    click('[data-testid="graph-reset"]');
    await flush();

    const reset = JSON.parse(storage.workspaces.get("ws-cards")!.layoutJson);
    expect(reset.futureSlice).toEqual({ keep: true });
    expect(reset.graph.positions["node-echo"]).not.toEqual({ x: 80, y: 100 });
  });

  it("renders real workspace edges between two capability nodes on the same server", async () => {
    storage.workspaceNodes.create({
      id: "node-clock",
      workspaceId: "ws-cards",
      serverId: "srv-local",
      capabilityId: "srv-local::tool::clock",
      argumentsJson: JSON.stringify({ timezone: "UTC" }),
    });
    storage.workspaces.update("ws-cards", {
      layoutJson: JSON.stringify({ projection: "graph", selectedNodeIds: [] }),
    });

    await act(async () => root.render(<App />));
    await flush();
    await flush();

    expect(container.querySelector('[data-testid="workspace-graph"]')).not.toBeNull();
    // Two nodes on the same server produce one sibling edge.
    expect(container.querySelectorAll(".workspace-graph-edge").length).toBeGreaterThanOrEqual(1);
  });

  it("bulk-action toolbar emits the expected API calls for Export / Compare / Handoff / Remove", async () => {
    storage.workspaceNodes.create({
      id: "node-clock",
      workspaceId: "ws-cards",
      serverId: "srv-local",
      capabilityId: "srv-local::tool::clock",
      argumentsJson: JSON.stringify({ timezone: "UTC" }),
    });
    const secondExec = storage.executions.create({
      id: "exec-clock",
      workspaceId: "ws-cards",
      workspaceNodeId: "node-clock",
      serverId: "srv-local",
      capabilityId: "srv-local::tool::clock",
      status: "complete",
    });
    storage.rounds.append({
      executionId: secondExec.id,
      roundIndex: 0,
      kind: "initial",
      argumentsJson: JSON.stringify({ timezone: "UTC" }),
      resultInlineJson: JSON.stringify({ now: "2026-08-29T00:00:00Z" }),
      durationMs: 5,
    });
    storage.workspaces.update("ws-cards", {
      layoutJson: JSON.stringify({ projection: "grid", selectedNodeIds: ["node-echo", "node-clock"] }),
    });

    await act(async () => root.render(<App />));
    await flush();
    await flush();

    expect(container.textContent).toContain("2 selected");

    // Export selected → POST /api/v1/packets/build with both execution IDs, JSON tier.
    click('[data-testid="export-selected"]');
    await flush();
    await flush();
    const exportCall = fetchSpy.mock.calls.find(([input, init]) => String(input).endsWith("/api/v1/packets/build") && (init as RequestInit | undefined)?.method === "POST");
    expect(exportCall).toBeDefined();
    const exportBody = JSON.parse((exportCall![1] as RequestInit).body as string);
    expect(exportBody.executionIds.sort()).toEqual(["exec-clock", "exec-echo"]);
    expect(exportBody.format).toBe("json");
    expect(container.querySelector('[data-testid="bulk-export-json"]')).not.toBeNull();

    // Compare selected → POST /api/v1/executions/compare with both IDs.
    click('[data-testid="compare-selected"]');
    await flush();
    await flush();
    const compareCall = fetchSpy.mock.calls.find(([input, init]) => String(input).endsWith("/api/v1/executions/compare") && (init as RequestInit | undefined)?.method === "POST");
    expect(compareCall).toBeDefined();
    const compareBody = JSON.parse((compareCall![1] as RequestInit).body as string);
    expect([compareBody.leftId, compareBody.rightId].sort()).toEqual(["exec-clock", "exec-echo"]);
    expect(container.querySelector('[data-testid="comparison-view"]')).not.toBeNull();

    // Handoff selected → POST /api/v1/packets/build with format=markdown.
    click('[data-testid="handoff-selected"]');
    await flush();
    await flush();
    const handoffCall = fetchSpy.mock.calls.filter(([input, init]) => String(input).endsWith("/api/v1/packets/build") && (init as RequestInit | undefined)?.method === "POST").pop();
    expect(handoffCall).toBeDefined();
    const handoffBody = JSON.parse((handoffCall![1] as RequestInit).body as string);
    expect(handoffBody.format).toBe("markdown");
    expect(container.querySelector('[data-testid="bulk-handoff-text"]')).not.toBeNull();

    // Remove selected → one DELETE per node id.
    click('[data-testid="remove-selected"]');
    await flush();
    await flush();
    const deleteCalls = fetchSpy.mock.calls.filter(([input, init]) => (init as RequestInit | undefined)?.method === "DELETE" && String(input).includes("/api/v1/workspaces/ws-cards/nodes/"));
    const deletedIds = deleteCalls.map(([input]) => String(input).split("/nodes/")[1]).sort();
    expect(deletedIds).toEqual(["node-clock", "node-echo"]);

    expect(storage.workspaceNodes.get("node-echo")).toBeFalsy();
    expect(storage.workspaceNodes.get("node-clock")).toBeFalsy();
  });
});
