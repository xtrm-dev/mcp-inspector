/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const stylesPath = resolve(__dirname, "../src/styles.css");
const css = readFileSync(stylesPath, "utf8");

let styleEl: HTMLStyleElement | null = null;

afterEach(() => {
  styleEl?.remove();
  styleEl = null;
});

describe("theme-matched scrollbars (mix-z7q)", () => {
  it("declares a shared ::-webkit-scrollbar block in styles.css", () => {
    expect(css).toMatch(/::-webkit-scrollbar\s*\{[^}]*width:\s*8px/);
    expect(css).toMatch(/::-webkit-scrollbar-thumb\s*\{[^}]*var\(--panel-active\)/);
    expect(css).toMatch(/::-webkit-scrollbar-thumb:hover\s*\{[^}]*var\(--line-strong\)/);
  });

  it("declares Firefox scrollbar-color / scrollbar-width using theme tokens", () => {
    expect(css).toMatch(/scrollbar-width:\s*thin/);
    expect(css).toMatch(/scrollbar-color:\s*var\(--panel-active\)\s+transparent/);
  });

  it("exposes the ::-webkit-scrollbar rule through document.styleSheets when loaded", () => {
    styleEl = document.createElement("style");
    styleEl.textContent = css;
    document.head.appendChild(styleEl);

    const sheet = styleEl.sheet as CSSStyleSheet;
    expect(sheet).toBeTruthy();
    const rules = Array.from(sheet.cssRules).map((r) => r.cssText);
    const hasWebkit = rules.some((t) => t.includes("::-webkit-scrollbar"));
    const hasFirefox = rules.some((t) => /scrollbar-color/.test(t));
    expect(hasWebkit || hasFirefox).toBe(true);
  });
});
