/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/app";

// ---- In-memory fake gateway, routed by method + pathname ----
// Covers the golden path the bead's VALIDATION section names: add server →
// run workspace → view history → export packet.

interface FakeState {
  servers: Array<{ id: string; displayName: string; transport: string; endpoint: string | null; connected: boolean }>;
  workspaces: Array<{ id: string; name: string; layoutJson: string; createdAt: string; updatedAt: string }>;
  nodes: Record<string, Array<{ id: string; workspaceId: string; serverId: string | null; capabilityId: string | null; argumentsJson: string | null; presentation: string; position: number; createdAt: string; updatedAt: string }>>;
  executions: Array<{ id: string; workspaceId: string | null; workspaceNodeId: string | null; captureSessionId: string | null; agentRunId: string | null; serverId: string; capabilityId: string; status: string; startedAt: string; endedAt: string | null }>;
}

function makeState(): FakeState {
  return { servers: [], workspaces: [], nodes: {}, executions: [] };
}

function setupFakeGateway(state: FakeState) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const url = new URL(input, "http://localhost");
      const path = url.pathname;
      const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {};
      const json = (data: unknown, status = 200) => ({
        ok: status >= 200 && status < 300,
        status,
        headers: { get: () => "application/json" },
        json: async () => data,
        text: async () => JSON.stringify(data),
      });
      const text = (data: string, status = 200) => ({
        ok: status >= 200 && status < 300,
        status,
        headers: { get: () => "text/markdown" },
        json: async () => ({}),
        text: async () => data,
      });

      if (path === "/api/v1/servers" && method === "GET") return json({ servers: state.servers });
      if (path === "/api/v1/servers" && method === "POST") {
        const id = `srv-${state.servers.length + 1}`;
        state.servers.push({
          id,
          displayName: String(body.displayName),
          transport: String(body.transport),
          endpoint: (body.endpoint as string | null) ?? null,
          connected: Boolean(body.connectNow),
        });
        return json({ server: state.servers[state.servers.length - 1], connected: true, negotiation: null }, 201);
      }
      const toolsMatch = /^\/api\/v1\/servers\/([^/]+)\/tools$/.exec(path);
      if (toolsMatch && method === "GET") {
        return json({
          tools: [{ name: "echo", description: "echoes input", inputSchema: { type: "object", properties: {} } }],
        });
      }
      const resourcesMatch = /^\/api\/v1\/servers\/([^/]+)\/resources$/.exec(path);
      if (resourcesMatch && method === "GET") return json({ resources: [], resourceTemplates: [] });
      const promptsMatch = /^\/api\/v1\/servers\/([^/]+)\/prompts$/.exec(path);
      if (promptsMatch && method === "GET") return json({ prompts: [] });

      if (path === "/api/v1/workspaces" && method === "GET") return json({ workspaces: state.workspaces });
      if (path === "/api/v1/workspaces" && method === "POST") {
        const id = `ws-${state.workspaces.length + 1}`;
        const now = new Date().toISOString();
        const ws = { id, name: String(body.name), layoutJson: "{}", createdAt: now, updatedAt: now };
        state.workspaces.push(ws);
        // Seed one tool node so "Run all" is immediately actionable — the
        // add-node form flow (schema form -> create node) is covered by
        // schema-form.test.tsx already, this test focuses on the golden
        // path across pages.
        state.nodes[id] = [
          {
            id: `node-1`,
            workspaceId: id,
            serverId: state.servers[0]?.id ?? null,
            capabilityId: state.servers[0] ? `${state.servers[0].id}::tool::echo` : null,
            argumentsJson: "{}",
            presentation: "collapsed",
            position: 0,
            createdAt: now,
            updatedAt: now,
          },
        ];
        return json({ workspace: ws }, 201);
      }
      const wsGetMatch = /^\/api\/v1\/workspaces\/([^/]+)$/.exec(path);
      if (wsGetMatch && method === "GET") {
        const id = wsGetMatch[1] as string;
        const ws = state.workspaces.find((w) => w.id === id);
        if (!ws) return json({ error: "not found" }, 404);
        return json({ workspace: ws, nodes: state.nodes[id] ?? [] });
      }
      const runMatch = /^\/api\/v1\/workspaces\/([^/]+)\/run$/.exec(path);
      if (runMatch && method === "POST") {
        const workspaceId = runMatch[1] as string;
        const nodes = state.nodes[workspaceId] ?? [];
        const executionId = `exec-1`;
        const agentRunId = `run-1`;
        const server = state.servers[0];
        state.executions.push({
          id: executionId,
          workspaceId,
          workspaceNodeId: nodes[0]?.id ?? null,
          captureSessionId: "cs-1",
          agentRunId,
          serverId: server?.id ?? "srv-1",
          capabilityId: nodes[0]?.capabilityId ?? "srv-1::tool::echo",
          status: "complete",
          startedAt: new Date().toISOString(),
          endedAt: new Date().toISOString(),
        });
        return json({
          runId: "run-exec-1",
          workspaceId,
          captureSessionId: "cs-1",
          agentRunId,
          concurrency: 4,
          nodes: nodes.map((n) => ({ nodeId: n.id, capabilityId: n.capabilityId, executionId, ok: true, durationMs: 12 })),
        });
      }
      const timelineMatch = /^\/api\/v1\/agent-runs\/([^/]+)\/timeline$/.exec(path);
      if (timelineMatch && method === "GET") {
        return json({
          agentRun: { id: timelineMatch[1], captureSessionId: "cs-1", correlationKind: "inspector-run", correlationKey: null, startedAt: new Date().toISOString(), endedAt: null, metadata: null },
          executions: state.executions,
          traces: [],
          overlay: state.executions.map((e) => ({ at: e.startedAt, kind: "execution", ref: { id: e.id, status: e.status, capabilityId: e.capabilityId, serverId: e.serverId } })),
        });
      }

      if (path === "/api/v1/executions" && method === "GET") return json({ executions: state.executions });
      const execGetMatch = /^\/api\/v1\/executions\/([^/]+)$/.exec(path);
      if (execGetMatch && method === "GET") {
        const id = execGetMatch[1] as string;
        const ex = state.executions.find((e) => e.id === id);
        if (!ex) return json({ error: "not found" }, 404);
        return json({ execution: ex, rounds: [{ id: "r1", executionId: id, roundIndex: 0, kind: "initial", argumentsJson: "{}", resultInlineJson: JSON.stringify({ ok: true }), resultArtifact: null, errorJson: null, durationMs: 5, startedAt: ex.startedAt, endedAt: ex.endedAt }], evidence: [] });
      }

      if (path === "/api/v1/packets/build" && method === "POST") {
        return text(`# Investigation Packet\n\nExecutions: ${(body.executionIds as string[]).join(", ")}\n`);
      }

      throw new Error(`unhandled fetch in golden-path test: ${method} ${path}`);
    }),
  );
}

let container: HTMLDivElement;
let root: Root;

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

function setNativeValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function click(el: Element | null) {
  if (!el) throw new Error("element not found");
  (el as HTMLElement).click();
}

function byTestId(id: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${id}"]`);
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("golden path: add server -> run workspace -> view history -> export packet", () => {
  it("walks the full flow through the real page components", async () => {
    const state = makeState();
    setupFakeGateway(state);

    await act(async () => {
      root.render(<App />);
    });
    await flush();

    // --- add server ---
    expect(byTestId("servers-page")).not.toBeNull();
    const nameInput = container.querySelector('input[required]') as HTMLInputElement;
    setNativeValue(nameInput, "Demo Server");
    const addServerForm = nameInput.closest("form")!;
    await act(async () => {
      addServerForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await flush();
    expect(state.servers).toHaveLength(1);
    expect(container.textContent).toContain("Demo Server");

    // --- create + run workspace ---
    click(byTestId("nav-workspaces"));
    await flush();
    expect(byTestId("workspaces-page")).not.toBeNull();

    const wsNameInput = container.querySelector('input[placeholder="New workspace name"]') as HTMLInputElement;
    setNativeValue(wsNameInput, "Demo Workspace");
    const createWsForm = wsNameInput.closest("form")!;
    await act(async () => {
      createWsForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await flush();
    expect(state.workspaces).toHaveLength(1);
    expect(byTestId("workspace-detail")).not.toBeNull();

    const runAllButtons = Array.from(container.querySelectorAll("button")).filter((b) => b.textContent === "Run all");
    expect(runAllButtons.length).toBe(1);
    await act(async () => {
      (runAllButtons[0] as HTMLButtonElement).click();
    });
    await flush();
    expect(state.executions).toHaveLength(1);
    expect(byTestId("trace-overlay")).not.toBeNull();

    // --- view execution history ---
    click(byTestId("nav-executions"));
    await flush();
    expect(byTestId("executions-page")).not.toBeNull();
    expect(container.textContent).toContain(state.executions[0]!.capabilityId);

    // --- export investigation packet ---
    click(byTestId("nav-packets"));
    await flush();
    expect(byTestId("packets-page")).not.toBeNull();
    const packetCheckbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    await act(async () => {
      packetCheckbox.click();
    });
    await flush();
    const buildButton = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.startsWith("Build packet"));
    expect(buildButton).toBeDefined();
    await act(async () => {
      buildButton!.click();
    });
    await flush();
    const output = byTestId("packet-output");
    expect(output?.textContent).toContain("Investigation Packet");
    expect(output?.textContent).toContain(state.executions[0]!.id);
  });
});
