/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ComparisonView } from "../src/components/ComparisonView";
import type { CompareResult, ExecutionRecord } from "../src/api/types";

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
});

function stubExec(id: string, overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  return {
    id,
    serverId: "srv-1",
    capabilityId: "srv-1::tool::add",
    status: "complete",
    startedAt: "2026-08-28T10:00:00Z",
    endedAt: "2026-08-28T10:00:01Z",
    createdAt: "2026-08-28T10:00:00Z",
    ...overrides,
  } as ExecutionRecord;
}

describe("ComparisonView — UX-5 slice 1", () => {
  it("renders the execution-meta lane with changed rows highlighted", () => {
    const left = stubExec("e1", { status: "complete" });
    const right = stubExec("e2", { status: "failed", endedAt: "2026-08-28T10:00:02Z" });
    const compare: CompareResult = { left, right };
    act(() => {
      root.render(<ComparisonView compare={compare} />);
    });
    const view = container.querySelector('[data-testid="comparison-view"]');
    expect(view).toBeTruthy();
    // Status row must be marked changed.
    const rows = Array.from(container.querySelectorAll("tr"));
    const statusRow = rows.find((r) => r.textContent?.startsWith("Status"));
    expect(statusRow?.className).toContain("comparison-changed");
    // Server row unchanged.
    const serverRow = rows.find((r) => r.textContent?.startsWith("Server"));
    expect(serverRow?.className).not.toContain("comparison-changed");
    // No raw JSON blob in the DOM.
    expect(container.querySelector("pre")).toBeNull();
  });

  it("renders extra compare fields when the API returns them alongside left/right", () => {
    const left = stubExec("e1");
    const right = stubExec("e2");
    const compare: CompareResult = {
      left,
      right,
      // Illustrative extra keys — the CompareResult contract allows
      // free-form fields.
      argumentsDiff: { left: { a: 1 }, right: { a: 2 } },
      resultShape: "table",
    };
    act(() => {
      root.render(<ComparisonView compare={compare} />);
    });
    // Extra lane rendered.
    const text = container.textContent ?? "";
    expect(text).toContain("Compare fields");
    expect(text).toContain("argumentsDiff");
    expect(text).toContain("resultShape");
    // No raw JSON blob in the DOM.
    expect(container.querySelector("pre")).toBeNull();
  });

  it("hides the extras lane when only left/right are present", () => {
    const compare: CompareResult = { left: stubExec("e1"), right: stubExec("e2") };
    act(() => {
      root.render(<ComparisonView compare={compare} />);
    });
    const text = container.textContent ?? "";
    expect(text).not.toContain("Compare fields");
  });
});
