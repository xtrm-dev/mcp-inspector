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
});
