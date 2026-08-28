/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  WorkspaceGraph,
  type GraphLayoutState,
} from "../src/components/WorkspaceGraph";
import type { ServerSummary, WorkspaceNodeRow } from "../src/api/types";

// jsdom lacks PointerEvent — polyfill from MouseEvent so React's synthetic
// pointer handlers receive an object with the fields it forwards.
class JsdomPointerEvent extends MouseEvent {
  pointerId = 1;
  constructor(type: string, init?: MouseEventInit) {
    super(type, init);
  }
}
if (typeof (globalThis as unknown as { PointerEvent?: unknown }).PointerEvent === "undefined") {
  (globalThis as unknown as { PointerEvent: unknown }).PointerEvent = JsdomPointerEvent;
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
});

function stubServer(id: string, displayName: string): ServerSummary {
  return {
    id,
    displayName,
    transport: "streamable-http",
    endpoint: `http://127.0.0.1:9/${id}`,
    protocolPolicy: "modern",
    disabled: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    connected: true,
    negotiation: null,
  };
}

function stubNode(id: string, serverId: string, capabilityId: string): WorkspaceNodeRow {
  return {
    id,
    workspaceId: "ws-1",
    serverId,
    capabilityId,
    argumentsJson: null,
    presentation: "collapsed",
    position: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as WorkspaceNodeRow;
}

describe("WorkspaceGraph — UX-3 slice 1", () => {
  it("renders one <g> per node, auto-placed by server", () => {
    const servers = [stubServer("s-1", "Alpha"), stubServer("s-2", "Beta")];
    const nodes = [
      stubNode("n-1", "s-1", "s-1::tool::add"),
      stubNode("n-2", "s-1", "s-1::tool::echo"),
      stubNode("n-3", "s-2", "s-2::tool::search"),
    ];
    const layout: GraphLayoutState = {};
    let selected: string | null = null;
    let stored: GraphLayoutState = layout;
    act(() => {
      root.render(
        <WorkspaceGraph
          nodes={nodes}
          servers={servers}
          selectedNodeId={selected}
          onSelect={(id) => { selected = id; }}
          layout={stored}
          onLayoutChange={(next) => { stored = next; }}
        />,
      );
    });
    // Three graph nodes rendered.
    const gnodes = container.querySelectorAll('[data-testid^="graph-node-"]');
    expect(gnodes.length).toBe(3);
    // Toolbar reports 3 nodes.
    expect(container.textContent).toMatch(/3 nodes/);
    // Auto-placement produced distinct positions (transforms differ).
    const transforms = Array.from(gnodes).map((g) => g.getAttribute("transform"));
    expect(new Set(transforms).size).toBe(3);
  });

  it("clicking a node selects it and clicking the canvas deselects", () => {
    const servers = [stubServer("s-1", "Alpha")];
    const nodes = [stubNode("n-1", "s-1", "s-1::tool::add")];
    let selected: string | null = null;
    const rerender = () => {
      root.render(
        <WorkspaceGraph
          nodes={nodes}
          servers={servers}
          selectedNodeId={selected}
          onSelect={(id) => {
            selected = id;
            rerender();
          }}
          layout={{}}
          onLayoutChange={() => {}}
        />,
      );
    };
    act(() => rerender());
    const gnode = container.querySelector('[data-testid="graph-node-n-1"]');
    expect(gnode).toBeTruthy();
    // Simulate pointer down on the node.
    act(() => {
      const event = new PointerEvent("pointerdown", { bubbles: true, clientX: 100, clientY: 100 });
      gnode!.dispatchEvent(event);
    });
    expect(selected).toBe("n-1");
    // Reset via pointer down on canvas (no data-graph-node ancestor).
    act(() => {
      const svg = container.querySelector('[data-testid="workspace-graph-svg"]');
      const event = new PointerEvent("pointerdown", { bubbles: true, clientX: 5, clientY: 5 });
      svg!.dispatchEvent(event);
    });
    expect(selected).toBeNull();
  });

  it("Reset button emits an onLayoutChange that clears positions + viewport", () => {
    const servers = [stubServer("s-1", "Alpha")];
    const nodes = [stubNode("n-1", "s-1", "s-1::tool::add")];
    const initial: GraphLayoutState = {
      positions: { "n-1": { x: 500, y: 500 } },
      viewport: { x: 100, y: 100, scale: 1.5 },
    };
    const changes: GraphLayoutState[] = [];
    act(() => {
      root.render(
        <WorkspaceGraph
          nodes={nodes}
          servers={servers}
          selectedNodeId={null}
          onSelect={() => {}}
          layout={initial}
          onLayoutChange={(next) => changes.push(next)}
        />,
      );
    });
    const resetBtn = container.querySelector<HTMLButtonElement>('[data-testid="graph-reset"]');
    expect(resetBtn).toBeTruthy();
    act(() => resetBtn!.click());
    // The reset handler emits ONE onLayoutChange with cleared positions and
    // default viewport. Verify only the last emitted state (the reset).
    const emitted = changes[changes.length - 1];
    expect(emitted).toBeDefined();
    expect(emitted!.positions).toBeUndefined();
    expect(emitted!.viewport).toEqual({ x: 0, y: 0, scale: 1 });
  });
});
