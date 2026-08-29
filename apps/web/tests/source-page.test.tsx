/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SourcePage } from "../src/pages/SourcePage";
import type {
  SourceCodeResponse,
  SourceGraphResponse,
  SourceRevision,
} from "../src/api/types";

// Stream E — SourcePage integration test: mode toggle, revision picker,
// graph render, code viewer sub-view render. Backend is stubbed by URL.

const REVISION: SourceRevision = {
  id: "rev-1",
  repositoryRef: "example/repo",
  revisionHash: "abcdef1234567",
  shortSha: "abcdef1",
  branch: "main",
  registeredAt: "2026-08-29T10:00:00Z",
  metadata: null,
} as unknown as SourceRevision;

const GRAPH: SourceGraphResponse = {
  revision: REVISION,
  nodes: [
    {
      id: "src/tools.ts#addNumbers",
      handlerSymbol: "addNumbers",
      filePath: "src/tools.ts",
      capabilityIds: ["srv-1::tool::add"],
      kind: "tool",
    },
    {
      id: "src/util.ts#sum",
      handlerSymbol: "sum",
      filePath: "src/util.ts",
      capabilityIds: [],
      kind: "tool",
    },
  ],
  staticEdges: [
    { fromId: "src/tools.ts#addNumbers", toId: "src/util.ts#sum", relation: "calls" },
  ],
  runtimeEdges: [
    {
      symbolId: "src/tools.ts#addNumbers",
      executionId: "e-1",
      capabilityId: "srv-1::tool::add",
      serverId: "srv-1",
      status: "complete",
      startedAt: "2026-08-29T10:05:00Z",
    },
  ],
};

const CODE: SourceCodeResponse = {
  symbol: {
    id: "src/tools.ts#addNumbers",
    handlerSymbol: "addNumbers",
    filePath: "src/tools.ts",
    lineStart: 10,
    lineEnd: 14,
    kind: "tool",
    capabilityId: "srv-1::tool::add",
  },
  snippet: {
    text: "function addNumbers(a, b) {\n  return sum(a, b)\n}",
    lineStart: 10,
    lineEnd: 12,
    truncated: false,
  },
  symbolText: "function addNumbers(a, b) {\n  return sum(a, b)\n}",
  fileText: "// tools.ts\nfunction addNumbers(a, b) { return sum(a, b) }\n",
  dependencies: [
    { symbolId: "src/util.ts#sum", filePath: "src/util.ts", handlerSymbol: "sum", kind: "tool" },
  ],
  dependents: [
    { symbolId: "src/api.ts#route", filePath: "src/api.ts", handlerSymbol: "route", kind: "tool" },
  ],
  trace: [
    {
      executionId: "e-1",
      capabilityId: "srv-1::tool::add",
      serverId: "srv-1",
      status: "complete",
      startedAt: "2026-08-29T10:05:00Z",
      endedAt: "2026-08-29T10:05:01Z",
    },
  ],
};

function stubFetch() {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/source/revisions") && !url.includes("/graph") && !url.includes("/code")) {
      return new Response(JSON.stringify({ sourceRevisions: [REVISION] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/graph")) {
      return new Response(JSON.stringify(GRAPH), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/code")) {
      return new Response(JSON.stringify(CODE), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  });
}

let container: HTMLDivElement;
let root: Root;

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
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

function click(el: Element | null) {
  if (!el) throw new Error("element not found");
  act(() => (el as HTMLElement).click());
}

describe("SourcePage — Stream E", () => {
  it("renders implementation view by default with revision list", async () => {
    await act(async () => root.render(<SourcePage />));
    await flush();
    expect(container.querySelector('[data-testid="source-mode-implementation"]')).toBeTruthy();
    // Revision row rendered.
    expect(container.textContent).toContain("example/repo");
  });

  it("switches to Runtime and renders the source graph", async () => {
    await act(async () => root.render(<SourcePage />));
    await flush();
    click(container.querySelector('[data-testid="source-mode-runtime"]'));
    await flush();
    expect(container.querySelector('[data-testid="source-runtime-view"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="source-graph"]')).toBeTruthy();
    // Two nodes.
    expect(container.querySelectorAll('[data-testid^="source-graph-node-"]').length).toBe(2);
    // Runtime edge for e-1 rendered.
    expect(container.querySelector('[data-testid="source-edge-runtime-e-1"]')).toBeTruthy();
    // Static edges hidden in Runtime overlay.
    expect(container.querySelector('[data-testid^="source-edge-static-"]')).toBeNull();
  });

  it("Combined mode overlays static AND runtime edges", async () => {
    await act(async () => root.render(<SourcePage />));
    await flush();
    click(container.querySelector('[data-testid="source-mode-combined"]'));
    await flush();
    expect(container.querySelector('[data-testid="source-combined-view"]')).toBeTruthy();
    expect(
      container.querySelector(
        '[data-testid="source-edge-static-src/tools.ts#addNumbers-src/util.ts#sum"]',
      ),
    ).toBeTruthy();
    expect(container.querySelector('[data-testid="source-edge-runtime-e-1"]')).toBeTruthy();
  });

  it("selecting a graph node opens the CodeViewer for that symbol", async () => {
    await act(async () => root.render(<SourcePage />));
    await flush();
    click(container.querySelector('[data-testid="source-mode-runtime"]'));
    await flush();
    const node = container.querySelector('[data-testid="source-graph-node-src/tools.ts#addNumbers"]');
    // Simulate pointer down (the graph binds to pointerdown for selection).
    // jsdom does not ship PointerEvent — MouseEvent with type "pointerdown"
    // is what React's SyntheticEvent dispatcher accepts here.
    act(() => {
      const ev = new MouseEvent("pointerdown", { bubbles: true, button: 0 });
      node?.dispatchEvent(ev);
    });
    await flush();
    expect(container.querySelector('[data-testid="code-viewer"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="code-viewer-title"]')?.textContent).toContain(
      "addNumbers",
    );
  });
});
