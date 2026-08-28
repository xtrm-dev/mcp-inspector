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

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "mix-web-shell-"));
  storage = openStorage({ dataDir });

  storage.servers.upsertById({
    id: "srv-local",
    displayName: "Local test server",
    transport: "streamable-http",
    endpoint: "http://127.0.0.1:9/mcp",
    protocolPolicy: "modern",
  });
  const workspace = storage.workspaces.create({
    id: "ws-durable",
    name: "Durable workspace",
    layoutJson: JSON.stringify({ view: "grid" }),
  });
  storage.workspaceNodes.create({
    id: "node-echo",
    workspaceId: workspace.id,
    serverId: "srv-local",
    capabilityId: "srv-local::tool::echo",
    argumentsJson: JSON.stringify({ text: "hello" }),
    presentation: "expanded",
  });

  const adapter = createSdkAdapter();
  const secrets = createSecretsRegistry({ storage });
  const serverManager = createServerManager({ storage, adapter, secrets });
  const gateway = buildGatewayApp({ adapter, storage, serverManager, secrets });

  vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, "http://localhost");
    return gateway.request(`${url.pathname}${url.search}`, init);
  });

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

describe("workspace-first shell", () => {
  it("lands on the durable workspace and projects its real API node into the canvas and detail pane", async () => {
    await act(async () => root.render(<App />));
    await flush();

    expect(container.querySelector('[data-testid="workspace-page"]')).not.toBeNull();
    expect(container.textContent).toContain("Durable workspace");
    expect(container.textContent).toContain("Local test server");
    expect(container.textContent).toContain("echo");
    // The seeded node has presentation:"expanded" — verify the detail pane
    // rendered the expanded body (the shell affordance flips to "Collapse"
    // when a node is expanded, and the tab strip is visible).
    const detailText = container.querySelector('[data-testid="workspace-detail-pane"]')?.textContent ?? "";
    expect(detailText).toMatch(/Collapse|Parameters|Protocol/);

    storage.workspaceNodes.create({
      id: "node-second",
      workspaceId: "ws-durable",
      serverId: "srv-local",
      capabilityId: "srv-local::tool::second-tool",
    });
    await act(async () => container.querySelector<HTMLElement>('[data-testid="nav-settings"]')?.click());
    await flush();
    await act(async () => container.querySelector<HTMLElement>('[data-testid="nav-workspace"]')?.click());
    await flush();
    await flush();

    expect(container.textContent).toContain("second-tool");
  });
});
