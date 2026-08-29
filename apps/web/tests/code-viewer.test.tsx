/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodeViewer } from "../src/components/CodeViewer";
import type { SourceCodeResponse } from "../src/api/types";

const CODE: SourceCodeResponse = {
  symbol: {
    id: "src/tools.ts#addNumbers",
    handlerSymbol: "addNumbers",
    filePath: "src/tools.ts",
    lineStart: 10,
    lineEnd: 12,
    kind: "tool",
    capabilityId: "srv-1::tool::add",
  },
  snippet: { text: "line10\nline11\nline12", lineStart: 10, lineEnd: 12, truncated: false },
  symbolText: "function addNumbers() {\n  return 42\n}",
  fileText: "// file header\nfunction addNumbers() {\n  return 42\n}\n",
  dependencies: [
    { symbolId: "src/util.ts#sum", filePath: "src/util.ts", handlerSymbol: "sum", kind: "tool" },
  ],
  dependents: [
    { symbolId: "src/api.ts#route", filePath: "src/api.ts", handlerSymbol: "route", kind: "tool" },
  ],
  trace: [
    {
      executionId: "e-42",
      capabilityId: "srv-1::tool::add",
      serverId: "srv-1",
      status: "complete",
      startedAt: "2026-08-29T10:05:00Z",
      endedAt: "2026-08-29T10:05:01Z",
    },
  ],
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  vi.stubGlobal("fetch", async () =>
    new Response(JSON.stringify(CODE), { status: 200, headers: { "content-type": "application/json" } }),
  );
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function flush() {
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

function click(el: Element | null) {
  if (!el) throw new Error("element not found");
  act(() => (el as HTMLElement).click());
}

describe("CodeViewer — all six sub-views", () => {
  it("renders the snippet with a numbered gutter by default", async () => {
    await act(async () =>
      root.render(<CodeViewer revisionId="rev-1" filePath="src/tools.ts" handlerSymbol="addNumbers" />),
    );
    await flush();
    expect(container.querySelector('[data-testid="code-viewer-snippet"]')).toBeTruthy();
    // Gutter starts at line 10.
    const gutters = container.querySelectorAll(".code-viewer-gutter");
    expect(gutters[0]?.textContent).toBe("10");
    expect(gutters[gutters.length - 1]?.textContent).toBe("12");
  });

  it("switching to Full symbol renders symbolText", async () => {
    await act(async () =>
      root.render(<CodeViewer revisionId="rev-1" filePath="src/tools.ts" handlerSymbol="addNumbers" />),
    );
    await flush();
    click(container.querySelector('[data-testid="code-viewer-mode-symbol"]'));
    await flush();
    expect(container.querySelector('[data-testid="code-viewer-symbol-text"]')).toBeTruthy();
  });

  it("Full file renders fileText from line 1", async () => {
    await act(async () =>
      root.render(<CodeViewer revisionId="rev-1" filePath="src/tools.ts" handlerSymbol="addNumbers" />),
    );
    await flush();
    click(container.querySelector('[data-testid="code-viewer-mode-file"]'));
    await flush();
    const container_ = container.querySelector('[data-testid="code-viewer-file-text"]');
    expect(container_).toBeTruthy();
    const gutters = container_?.querySelectorAll(".code-viewer-gutter");
    expect(gutters?.[0]?.textContent).toBe("1");
  });

  it("Dependencies lists outgoing symbols; clicking calls onNavigate", async () => {
    const spy = vi.fn();
    await act(async () =>
      root.render(
        <CodeViewer
          revisionId="rev-1"
          filePath="src/tools.ts"
          handlerSymbol="addNumbers"
          onNavigate={spy}
        />,
      ),
    );
    await flush();
    click(container.querySelector('[data-testid="code-viewer-mode-dependencies"]'));
    await flush();
    click(container.querySelector('[data-testid="code-viewer-dep-src/util.ts#sum"]'));
    expect(spy).toHaveBeenCalledWith("src/util.ts", "sum");
  });

  it("Dependents lists incoming symbols", async () => {
    await act(async () =>
      root.render(<CodeViewer revisionId="rev-1" filePath="src/tools.ts" handlerSymbol="addNumbers" />),
    );
    await flush();
    click(container.querySelector('[data-testid="code-viewer-mode-dependents"]'));
    await flush();
    expect(container.querySelector('[data-testid="code-viewer-dependent-src/api.ts#route"]')).toBeTruthy();
  });

  it("Runtime trace lists observed executions", async () => {
    await act(async () =>
      root.render(<CodeViewer revisionId="rev-1" filePath="src/tools.ts" handlerSymbol="addNumbers" />),
    );
    await flush();
    click(container.querySelector('[data-testid="code-viewer-mode-trace"]'));
    await flush();
    expect(container.querySelector('[data-testid="code-viewer-trace-e-42"]')).toBeTruthy();
  });

  it("renders explicit empty states when text is not indexed", async () => {
    vi.stubGlobal("fetch", async () =>
      new Response(
        JSON.stringify({ ...CODE, symbolText: null, fileText: null, dependencies: [], dependents: [], trace: [] }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    await act(async () =>
      root.render(<CodeViewer revisionId="rev-1" filePath="src/tools.ts" handlerSymbol="addNumbers" />),
    );
    await flush();
    click(container.querySelector('[data-testid="code-viewer-mode-symbol"]'));
    await flush();
    expect(container.querySelector('[data-testid="code-viewer-symbol-empty"]')).toBeTruthy();
    click(container.querySelector('[data-testid="code-viewer-mode-file"]'));
    await flush();
    expect(container.querySelector('[data-testid="code-viewer-file-empty"]')).toBeTruthy();
    click(container.querySelector('[data-testid="code-viewer-mode-dependencies"]'));
    await flush();
    expect(container.querySelector('[data-testid="code-viewer-deps-empty"]')).toBeTruthy();
    click(container.querySelector('[data-testid="code-viewer-mode-dependents"]'));
    await flush();
    expect(container.querySelector('[data-testid="code-viewer-dependents-empty"]')).toBeTruthy();
    click(container.querySelector('[data-testid="code-viewer-mode-trace"]'));
    await flush();
    expect(container.querySelector('[data-testid="code-viewer-trace-empty"]')).toBeTruthy();
  });
});
