/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentRunWaterfall } from "../src/components/AgentRunWaterfall";
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
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe("AgentRunWaterfall — UX-6 slice 2", () => {
  it("renders empty when the agent run has no executions", async () => {
    stubTimeline({
      agentRun: {} as unknown as Data["agentRun"],
      executions: [],
      traces: [],
      overlay: [],
    });
    await act(async () => root.render(<AgentRunWaterfall agentRunId="r-1" />));
    await flush();
    expect(container.querySelector('[data-testid="waterfall-empty"]')).toBeTruthy();
  });

  it("renders one row per execution with duration proportional to elapsed time", async () => {
    stubTimeline({
      agentRun: {} as unknown as Data["agentRun"],
      executions: [
        {
          id: "e1",
          serverId: "srv-1",
          capabilityId: "srv-1::tool::add",
          status: "complete",
          startedAt: "2026-08-28T10:00:00Z",
          endedAt: "2026-08-28T10:00:01Z",
          createdAt: "2026-08-28T10:00:00Z",
        } as unknown as Data["executions"][number],
        {
          id: "e2",
          serverId: "srv-1",
          capabilityId: "srv-1::tool::echo",
          status: "failed",
          startedAt: "2026-08-28T10:00:02Z",
          endedAt: "2026-08-28T10:00:03Z",
          createdAt: "2026-08-28T10:00:02Z",
        } as unknown as Data["executions"][number],
      ],
      traces: [],
      overlay: [],
    });
    await act(async () => root.render(<AgentRunWaterfall agentRunId="r-1" />));
    await flush();
    const rows = container.querySelectorAll('[data-testid^="waterfall-row-"]');
    expect(rows.length).toBe(2);
    // Duration text present.
    expect(container.textContent).toMatch(/1000 ms/);
    // Status classes applied.
    expect(container.querySelectorAll(".waterfall-bar-complete").length).toBe(1);
    expect(container.querySelectorAll(".waterfall-bar-failed").length).toBe(1);
  });

  it("marks executions with no endedAt as running", async () => {
    stubTimeline({
      agentRun: {} as unknown as Data["agentRun"],
      executions: [
        {
          id: "e-running",
          serverId: "srv-1",
          capabilityId: "srv-1::tool::slow",
          status: "task_working",
          startedAt: "2026-08-28T10:00:00Z",
          endedAt: null,
          createdAt: "2026-08-28T10:00:00Z",
        } as unknown as Data["executions"][number],
      ],
      traces: [],
      overlay: [],
    });
    await act(async () => root.render(<AgentRunWaterfall agentRunId="r-1" />));
    await flush();
    expect(container.querySelector(".waterfall-bar-running")).toBeTruthy();
    expect(container.querySelector(".waterfall-bar-active")).toBeTruthy();
  });
});
