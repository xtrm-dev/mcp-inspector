/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SourcePage } from "../src/pages/SourcePage";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("fetch", async (input: string | URL) => {
    const url = typeof input === "string" ? input : input.href;
    const path = new URL(url, "http://localhost").pathname;
    if (path === "/api/v1/source-revisions") {
      return new Response(
        JSON.stringify({ sourceRevisions: [] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("not stubbed", { status: 501 });
  });
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

describe("SourcePage — UX-7 slice 1", () => {
  it("defaults to Implementation mode and renders the registration form", async () => {
    await act(async () => root.render(<SourcePage />));
    await flush();
    const implTab = container.querySelector('[data-testid="source-mode-implementation"]');
    expect(implTab?.getAttribute("aria-selected")).toBe("true");
    // Registration form is the Implementation mode content.
    expect(container.querySelector('form')).toBeTruthy();
    // Runtime placeholder NOT rendered by default.
    expect(container.querySelector('[data-testid="source-runtime-placeholder"]')).toBeNull();
  });

  it("swapping to Runtime mode swaps the description and shows the Runtime placeholder", async () => {
    await act(async () => root.render(<SourcePage />));
    await flush();
    const runtimeTab = container.querySelector<HTMLButtonElement>(
      '[data-testid="source-mode-runtime"]',
    );
    await act(async () => runtimeTab!.click());
    expect(runtimeTab?.getAttribute("aria-selected")).toBe("true");
    expect(container.querySelector('[data-testid="source-runtime-placeholder"]')).toBeTruthy();
    // Registration form hidden in Runtime mode.
    expect(container.querySelector('form')).toBeNull();
    const desc = container.querySelector('[data-testid="source-mode-description"]');
    expect(desc?.textContent).toMatch(/Runtime-confirmed edges/);
  });

  it("Combined mode shows the overlay placeholder", async () => {
    await act(async () => root.render(<SourcePage />));
    await flush();
    const combinedTab = container.querySelector<HTMLButtonElement>(
      '[data-testid="source-mode-combined"]',
    );
    await act(async () => combinedTab!.click());
    expect(container.querySelector('[data-testid="source-combined-placeholder"]')).toBeTruthy();
    const desc = container.querySelector('[data-testid="source-mode-description"]');
    expect(desc?.textContent).toMatch(/Overlay/);
  });
});
