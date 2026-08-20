/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RendererView } from "../src/renderer-view";

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

function mockFetch(handler: (url: string) => unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => ({
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      json: async () => handler(input),
      text: async () => JSON.stringify(handler(input)),
    })),
  );
}

describe("RendererView", () => {
  it("renders a small inline value directly without paging", async () => {
    mockFetch(() => ({ renderers: [] }));
    await act(async () => {
      root.render(<RendererView value={{ hello: "world" }} suggestedRenderer="json-tree" />);
    });
    expect(container.textContent).toContain("hello");
    expect(container.querySelector('[data-testid="virtual-list"]')).toBeNull();
  });

  it("large payloads load through the artifact page endpoint and virtualize — only a bounded window of rows is in the DOM", async () => {
    const TOTAL_ROWS = 1000; // simulates a ~200KiB ndjson payload spilled to an artifact
    mockFetch((url) => {
      if (url.startsWith("/api/v1/renderers")) return { renderers: [] };
      const u = new URL(url, "http://localhost");
      const offset = Number(u.searchParams.get("offset") ?? "0");
      const limit = Number(u.searchParams.get("limit") ?? "200");
      const end = Math.min(TOTAL_ROWS, offset + limit);
      return {
        artifactRef: "sha-large",
        offset,
        limit,
        hasMore: end < TOTAL_ROWS,
        lines: Array.from({ length: end - offset }, (_, i) => `{"row":${offset + i}}`),
      };
    });

    await act(async () => {
      root.render(<RendererView resultArtifact="sha-large" suggestedRenderer="ndjson" />);
    });
    // Allow the first page's async fetch + state update to settle.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const list = container.querySelector('[data-testid="virtual-list"]');
    expect(list).not.toBeNull();
    // Only the first page (200 rows) has been fetched, and only a small
    // windowed slice of those rows is actually rendered into the DOM —
    // never all 1000.
    const renderedRows = container.querySelectorAll(".renderer-row");
    expect(renderedRows.length).toBeGreaterThan(0);
    expect(renderedRows.length).toBeLessThan(TOTAL_ROWS);
    expect(container.textContent).not.toContain(`"row":999`);
  });
});
