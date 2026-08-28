/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CapabilitiesPage } from "../src/pages/CapabilitiesPage";

// Synthetic fetch stub keeps the test focused on catalog UI behavior —
// filter composition, selection semantics, and add-to-workspace fan-out.
// Real end-to-end wiring (getServerCapabilities → SDK adapter →
// MCP server) is covered elsewhere (custom-headers.test.ts, mrtr.test.ts,
// tasks.test.ts).

interface StubServer {
  id: string;
  displayName: string;
  connected: boolean;
  tools: Array<{ name: string; description?: string }>;
  resources?: Array<{ uri: string; name?: string; description?: string }>;
  prompts?: Array<{ name: string; description?: string }>;
}

let container: HTMLDivElement;
let root: Root;
let createNodeCalls: Array<{ workspaceId: string; body: unknown }>;

function stubFetch(servers: StubServer[]) {
  createNodeCalls = [];
  vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.href;
    const path = new URL(url, "http://localhost").pathname;
    if (path === "/api/v1/servers") {
      return jsonResponse({
        servers: servers.map((s) => ({
          id: s.id,
          displayName: s.displayName,
          transport: "streamable-http",
          endpoint: `http://127.0.0.1:9/${s.id}`,
          protocolPolicy: "modern",
          disabled: false,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          connected: s.connected,
          negotiation: null,
        })),
      });
    }
    const capsMatch = /^\/api\/v1\/servers\/([^/]+)\/capabilities$/.exec(path);
    if (capsMatch) {
      const server = servers.find((s) => s.id === capsMatch[1]);
      if (!server) return jsonResponse({ tools: [], resources: [], resourceTemplates: [], prompts: [] });
      return jsonResponse({
        tools: server.tools,
        resources: server.resources ?? [],
        resourceTemplates: [],
        prompts: server.prompts ?? [],
      });
    }
    // Fallbacks for the three per-kind endpoints getServerCapabilities uses.
    const toolsMatch = /^\/api\/v1\/servers\/([^/]+)\/tools$/.exec(path);
    if (toolsMatch) {
      const s = servers.find((x) => x.id === toolsMatch[1]);
      return jsonResponse({ tools: s?.tools ?? [] });
    }
    const resMatch = /^\/api\/v1\/servers\/([^/]+)\/resources$/.exec(path);
    if (resMatch) {
      const s = servers.find((x) => x.id === resMatch[1]);
      return jsonResponse({ resources: s?.resources ?? [], resourceTemplates: [] });
    }
    const promptsMatch = /^\/api\/v1\/servers\/([^/]+)\/prompts$/.exec(path);
    if (promptsMatch) {
      const s = servers.find((x) => x.id === promptsMatch[1]);
      return jsonResponse({ prompts: s?.prompts ?? [] });
    }
    if (path === "/api/v1/workspaces" && (!init || init.method === "GET" || !init.method)) {
      return jsonResponse({
        workspaces: [
          {
            id: "ws-test",
            name: "Test workspace",
            layoutJson: "{}",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
      });
    }
    const nodeMatch = /^\/api\/v1\/workspaces\/([^/]+)\/nodes$/.exec(path);
    if (nodeMatch && init?.method === "POST") {
      const body = JSON.parse(String(init.body ?? "{}"));
      createNodeCalls.push({ workspaceId: nodeMatch[1]!, body });
      return jsonResponse({
        node: {
          id: `node-${createNodeCalls.length}`,
          workspaceId: nodeMatch[1]!,
          serverId: body.serverId,
          capabilityId: body.capabilityId,
          argumentsJson: null,
          presentation: body.presentation ?? "collapsed",
          position: 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      });
    }
    return new Response("not stubbed", { status: 501 });
  });
}

function setInputValue(el: HTMLInputElement, value: string): void {
  // React tracks the value on the element via a hidden _valueTracker. Setting
  // `el.value` directly skips React's onChange because the tracker sees no
  // native mutation. Route through the native setter so React's synthetic
  // event fires.
  const proto = Object.getPrototypeOf(el) as typeof HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function flush() {
  // Two frames: one for the top-level fetch resolution, one for the
  // capability fan-out that resolves inside a state setter.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe("CapabilitiesPage — R-UX slice UX-4", () => {
  it("lists tools + resources + prompts across all connected servers", async () => {
    stubFetch([
      {
        id: "s-alpha",
        displayName: "Alpha",
        connected: true,
        tools: [{ name: "add_numbers", description: "Sum two numbers" }],
        resources: [{ uri: "mem://readme", name: "README" }],
      },
      {
        id: "s-beta",
        displayName: "Beta",
        connected: true,
        tools: [{ name: "search", description: "Full-text search" }],
        prompts: [{ name: "greet", description: "Greet by name" }],
      },
      {
        id: "s-offline",
        displayName: "Offline",
        connected: false,
        tools: [{ name: "invisible" }],
      },
    ]);
    await act(async () => {
      root.render(<CapabilitiesPage />);
    });
    await flush();
    const rowText = container.textContent ?? "";
    expect(rowText).toContain("add_numbers");
    expect(rowText).toContain("search");
    expect(rowText).toContain("README");
    expect(rowText).toContain("greet");
    // Disconnected server tools are hidden by default.
    expect(rowText).not.toContain("invisible");
  });

  it("filters by search text and by kind", async () => {
    stubFetch([
      {
        id: "s-1",
        displayName: "One",
        connected: true,
        tools: [
          { name: "add_numbers", description: "Sum two numbers" },
          { name: "search", description: "Full-text search" },
        ],
        prompts: [{ name: "greet", description: "Greet by name" }],
      },
    ]);
    await act(async () => {
      root.render(<CapabilitiesPage />);
    });
    await flush();

    // Text search: "sum" should hit add_numbers only.
    const searchInput = container.querySelector<HTMLInputElement>(
      '[data-testid="catalog-search"]',
    );
    expect(searchInput).toBeTruthy();
    await act(async () => {
      setInputValue(searchInput!, "sum");
    });
    const afterSearch = container.textContent ?? "";
    expect(afterSearch).toContain("add_numbers");
    expect(afterSearch).not.toContain("greet");

    // Clear search, then apply kind filter = prompt only.
    await act(async () => {
      setInputValue(searchInput!, "");
    });
    const promptChip = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Prompt",
    );
    expect(promptChip).toBeTruthy();
    await act(async () => {
      promptChip!.click();
    });
    const afterKind = container.textContent ?? "";
    expect(afterKind).toContain("greet");
    expect(afterKind).not.toContain("add_numbers");
    expect(afterKind).not.toContain("search");
  });

  it("adds selected capabilities to the chosen workspace via createWorkspaceNode", async () => {
    stubFetch([
      {
        id: "s-1",
        displayName: "One",
        connected: true,
        tools: [
          { name: "add_numbers", description: "Sum two numbers" },
          { name: "search", description: "Full-text search" },
        ],
      },
    ]);
    await act(async () => {
      root.render(<CapabilitiesPage />);
    });
    await flush();

    // Select both rows.
    const checkboxes = Array.from(
      container.querySelectorAll<HTMLInputElement>('input[type="checkbox"][aria-label^="select"]'),
    );
    expect(checkboxes.length).toBe(2);
    for (const cb of checkboxes) {
      await act(async () => {
        cb.click();
      });
    }
    const count = container.querySelector('[data-testid="catalog-selection-count"]')?.textContent ?? "";
    expect(count).toContain("2");

    // Open modal.
    const addBtn = container.querySelector<HTMLButtonElement>(
      '[data-testid="catalog-add-selected"]',
    );
    expect(addBtn?.disabled).toBe(false);
    await act(async () => {
      addBtn!.click();
    });
    await flush();
    expect(container.querySelector('[data-testid="add-to-workspace-modal"]')).toBeTruthy();

    // Submit — should call createWorkspaceNode twice.
    const submit = container.querySelector<HTMLButtonElement>(
      '[data-testid="add-modal-submit"]',
    );
    await act(async () => {
      submit!.click();
    });
    await flush();
    expect(createNodeCalls.length).toBe(2);
    expect(new Set(createNodeCalls.map((c) => (c.body as { capabilityId: string }).capabilityId))).toEqual(
      new Set(["s-1::tool::add_numbers", "s-1::tool::search"]),
    );
    expect(createNodeCalls.every((c) => c.workspaceId === "ws-test")).toBe(true);
  });
});
