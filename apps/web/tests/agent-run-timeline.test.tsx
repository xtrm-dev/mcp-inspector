/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentRunTimeline } from "../src/components/AgentRunTimeline";
import type { AgentRunTimeline as Data } from "../src/api/types";

let container: HTMLDivElement;
let root: Root;

const AGENT_RUN_ID = "run-1";

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

describe("AgentRunTimeline — UX-6 slice 1", () => {
  it("renders empty state when the run has no overlay entries", async () => {
    stubTimeline({
      agentRun: {
        id: AGENT_RUN_ID,
        correlationKind: "w3c-trace",
        correlationKey: "trace-1",
        startedAt: "2026-08-28T10:00:00Z",
        endedAt: null,
      } as unknown as Data["agentRun"],
      executions: [],
      traces: [],
      overlay: [],
    });
    await act(async () => {
      root.render(<AgentRunTimeline agentRunId={AGENT_RUN_ID} />);
    });
    await flush();
    expect(container.querySelector('[data-testid="timeline-empty"]')).toBeTruthy();
  });

  it("groups overlay entries into lanes and renders one mark per entry", async () => {
    stubTimeline({
      agentRun: {
        id: AGENT_RUN_ID,
        correlationKind: "w3c-trace",
        correlationKey: "trace-1",
        startedAt: "2026-08-28T10:00:00Z",
        endedAt: "2026-08-28T10:00:10Z",
      } as unknown as Data["agentRun"],
      executions: [],
      traces: [],
      overlay: [
        {
          at: "2026-08-28T10:00:00Z",
          kind: "execution",
          ref: { id: "e1", status: "complete", capabilityId: "srv-1::tool::add", serverId: "srv-1" },
        },
        {
          at: "2026-08-28T10:00:05Z",
          kind: "execution",
          ref: { id: "e2", status: "failed", capabilityId: "srv-1::tool::add", serverId: "srv-1" },
        },
        {
          at: "2026-08-28T10:00:10Z",
          kind: "span",
          ref: { id: "s1", traceId: "trace-1", name: "http.request" },
        },
      ],
    });
    await act(async () => {
      root.render(<AgentRunTimeline agentRunId={AGENT_RUN_ID} />);
    });
    await flush();
    // Two lanes: one execution (grouped by srv-1::tool::add), one span (trace-1).
    const lanes = container.querySelectorAll('[data-testid^="timeline-lane-"]');
    expect(lanes.length).toBe(2);
    // Three marks total.
    const marks = container.querySelectorAll(".agent-timeline-mark");
    expect(marks.length).toBe(3);
    // Status classes are applied.
    expect(
      container.querySelectorAll(".timeline-exec-complete").length +
        container.querySelectorAll(".timeline-exec-failed").length +
        container.querySelectorAll(".timeline-span").length,
    ).toBe(3);
  });
});
