/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExecutionsPage } from "../src/pages/ExecutionsPage";
import type { ExecutionDetail, ExecutionRecord, ServerSummary } from "../src/api/types";

let container: HTMLDivElement;
let root: Root;

const EXEC: ExecutionRecord = {
  id: "e-1", workspaceId: null, workspaceNodeId: null,
  captureSessionId: null, agentRunId: null,
  serverId: "srv-1", capabilityId: "srv-1::tool::echo",
  status: "complete",
  startedAt: "2026-08-28T10:00:00Z", endedAt: "2026-08-28T10:00:01Z",
  metadata: null,
};

const DETAIL: ExecutionDetail = {
  execution: EXEC,
  rounds: [
    {
      id: "r-1", executionId: "e-1", roundIndex: 0,
      kind: "call" as ExecutionDetail["rounds"][number]["kind"],
      argumentsJson: null,
      resultInlineJson: JSON.stringify({ ok: true }),
      resultArtifact: null, errorJson: null, durationMs: 1000,
      startedAt: "2026-08-28T10:00:00Z", endedAt: "2026-08-28T10:00:01Z",
    },
  ],
  evidence: [],
};

const SERVERS: { servers: ServerSummary[] } = {
  servers: [{
    id: "srv-1", displayName: "Local",
    transport: "streamable-http", endpoint: "http://x/mcp",
    protocolPolicy: "auto", disabled: false,
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
    connected: true, negotiation: null,
  }],
};

function stubFetch() {
  vi.stubGlobal("fetch", async (input: string | URL | Request) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, "http://localhost");
    let body: unknown;
    if (url.pathname === "/api/v1/executions") body = { executions: [EXEC] };
    else if (url.pathname === "/api/v1/servers") body = SERVERS;
    else if (url.pathname.startsWith("/api/v1/executions/")) body = DETAIL;
    else body = {};
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  stubFetch();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function flush() {
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

describe("Executions page uses shared CapabilityInspector — Stream D", () => {
  it("renders the shared inspector with tabs when an execution is selected", async () => {
    await act(async () => root.render(<ExecutionsPage />));
    await flush();
    // Click the row to select.
    const row = container.querySelector("tbody tr");
    if (!row) throw new Error("execution row not rendered");
    await act(async () => {
      (row.querySelectorAll("td")[1] as HTMLElement).click();
    });
    await flush();
    // Inspector wrapper is present.
    expect(container.querySelector('[data-testid="execution-inspector"]')).toBeTruthy();
    // Shared tabs are wired — Result tab exists and Source/Logs placeholders render.
    expect(container.querySelector('[data-testid="inspection-tab-result-e-1"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="inspection-tab-source-e-1"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="inspection-tab-logs-e-1"]')).toBeTruthy();
    // Switching to the Source tab renders the placeholder.
    const sourceTab = container.querySelector('[data-testid="inspection-tab-source-e-1"]') as HTMLElement;
    await act(async () => sourceTab.click());
    expect(container.querySelector('[data-testid="source-tab-placeholder"]')).toBeTruthy();
    const logsTab = container.querySelector('[data-testid="inspection-tab-logs-e-1"]') as HTMLElement;
    await act(async () => logsTab.click());
    expect(container.querySelector('[data-testid="logs-tab-placeholder"]')).toBeTruthy();
  });
});
