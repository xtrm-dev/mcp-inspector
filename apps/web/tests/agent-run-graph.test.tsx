/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentRunGraph } from "../src/components/AgentRunGraph";
import type { AgentRunTimeline as Data } from "../src/api/types";

let container: HTMLDivElement;
let root: Root;

function stubTimeline(data: Data) {
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify(data), {
    status: 200,
    headers: { "content-type": "application/json" },
  }));
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
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

describe("AgentRunGraph — UX-6 slice 3", () => {
  it("renders empty state when the agent run has no executions", async () => {
    stubTimeline({
      agentRun: {} as unknown as Data["agentRun"],
      executions: [],
      traces: [],
      overlay: [],
    });
    await act(async () => root.render(<AgentRunGraph agentRunId="r-1" />));
    await flush();
    expect(container.querySelector('[data-testid="agent-graph-empty"]')).toBeTruthy();
  });

  it("renders one node per execution and edges between siblings ordered by startedAt", async () => {
    stubTimeline({
      agentRun: {} as unknown as Data["agentRun"],
      executions: [
        {
          id: "e2", serverId: "srv-1", capabilityId: "srv-1::tool::b",
          status: "complete",
          startedAt: "2026-08-28T10:00:02Z", endedAt: "2026-08-28T10:00:03Z",
          createdAt: "2026-08-28T10:00:02Z",
        } as unknown as Data["executions"][number],
        {
          id: "e1", serverId: "srv-1", capabilityId: "srv-1::tool::a",
          status: "complete",
          startedAt: "2026-08-28T10:00:00Z", endedAt: "2026-08-28T10:00:01Z",
          createdAt: "2026-08-28T10:00:00Z",
        } as unknown as Data["executions"][number],
        {
          id: "e3", serverId: "srv-1", capabilityId: "srv-1::tool::c",
          status: "failed",
          startedAt: "2026-08-28T10:00:04Z", endedAt: "2026-08-28T10:00:05Z",
          createdAt: "2026-08-28T10:00:04Z",
        } as unknown as Data["executions"][number],
      ],
      traces: [],
      overlay: [],
    });
    await act(async () => root.render(<AgentRunGraph agentRunId="r-1" />));
    await flush();
    expect(container.querySelectorAll('[data-testid^="agent-graph-node-"]').length).toBe(3);
    // Edges reflect start-time order: e1→e2, e2→e3.
    expect(container.querySelector('[data-testid="agent-graph-edge-e1-e2"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="agent-graph-edge-e2-e3"]')).toBeTruthy();
  });
});
