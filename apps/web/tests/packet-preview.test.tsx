/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PacketsPage } from "../src/pages/PacketsPage";

let container: HTMLDivElement;
let root: Root;

function stubExecutions(execs: Array<{ id: string; capabilityId: string; status: string }>) {
  vi.stubGlobal("fetch", async (input: string | URL) => {
    const url = typeof input === "string" ? input : input.href;
    const path = new URL(url, "http://localhost").pathname;
    if (path.startsWith("/api/v1/executions")) {
      return new Response(
        JSON.stringify({
          executions: execs.map((e) => ({
            id: e.id,
            capabilityId: e.capabilityId,
            status: e.status,
            serverId: "srv-1",
            createdAt: new Date().toISOString(),
            startedAt: new Date().toISOString(),
            endedAt: e.status === "complete" || e.status === "failed" ? new Date().toISOString() : null,
          })),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("not stubbed", { status: 501 });
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
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe("PacketsPage — R-UX slice UX-8 (will-include preview)", () => {
  it("hides the preview panel when no executions are selected", async () => {
    stubExecutions([{ id: "e1", capabilityId: "srv-1::tool::add", status: "complete" }]);
    await act(async () => root.render(<PacketsPage />));
    await flush();
    expect(container.querySelector('[data-testid="packet-will-include"]')).toBeNull();
  });

  it("shows the preview panel after selecting an execution, marks tier-excluded categories", async () => {
    stubExecutions([
      { id: "e1", capabilityId: "srv-1::tool::add", status: "complete" },
      { id: "e2", capabilityId: "srv-1::tool::add", status: "failed" },
    ]);
    await act(async () => root.render(<PacketsPage />));
    await flush();
    const cbs = Array.from(
      container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    );
    expect(cbs.length).toBe(2);
    await act(async () => {
      cbs[0]!.click();
    });
    const preview = container.querySelector('[data-testid="packet-will-include"]');
    expect(preview).toBeTruthy();
    // Compact tier excludes "diffs" and "trace"; the preview marks that.
    // Default tier is "investigation" — diffs are excluded.
    const diffsRow = container.querySelector('[data-testid="packet-cat-diffs"]');
    expect(diffsRow?.textContent).toContain("excluded by tier");
  });

  it("marks previous_good_run as available only when at least one failed and one complete are selected", async () => {
    stubExecutions([
      { id: "e1", capabilityId: "srv-1::tool::add", status: "complete" },
      { id: "e2", capabilityId: "srv-1::tool::add", status: "failed" },
    ]);
    await act(async () => root.render(<PacketsPage />));
    await flush();
    const cbs = Array.from(
      container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    );
    // Select only the failed one — previous_good_run marked partial (no
    // paired success in selection).
    await act(async () => cbs[1]!.click());
    const partial = container.querySelector('[data-testid="packet-cat-previous_good_run"]');
    expect(partial?.textContent).toMatch(/partial|n\/a/);
    // Also select the complete one — now it becomes available.
    await act(async () => cbs[0]!.click());
    const both = container.querySelector('[data-testid="packet-cat-previous_good_run"]');
    expect(both?.textContent).toContain("included");
  });
});
