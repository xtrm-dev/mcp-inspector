/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ServersPage } from "../src/pages/ServersPage";

let container: HTMLDivElement;
let root: Root;
let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchSpy = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, "http://localhost");
    const method = init?.method ?? "GET";
    const respond = (payload: unknown, status = 200) => ({
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => "application/json" },
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    });
    if (url.pathname === "/api/v1/servers" && method === "GET") return respond({ servers: [] });
    if (url.pathname === "/api/v1/servers" && method === "POST") return respond({ server: { id: "srv-new" }, connected: true, negotiation: null });
    return respond({ ok: true });
  });
  vi.stubGlobal("fetch", fetchSpy);

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
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function fill(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
    : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype
    : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  act(() => {
    setter?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function q<T extends Element = HTMLElement>(selector: string): T {
  const el = container.querySelector<T>(selector);
  if (!el) throw new Error(`missing ${selector}`);
  return el;
}

describe("AddServer form — stdio transport", () => {
  it("hides endpoint and submits command/args/cwd/env in the CreateServerInput", async () => {
    await act(async () => root.render(<ServersPage />));
    await flush();

    // Display name is the first required <input>.
    fill(q<HTMLInputElement>('form.panel input[required]'), "Local stdio server");
    fill(q<HTMLSelectElement>('form.panel select'), "stdio");
    await flush();

    expect(container.querySelector('[data-testid="server-endpoint"]')).toBeNull();

    fill(q<HTMLInputElement>('[data-testid="stdio-command"]'), "/opt/servers/echo");
    fill(q<HTMLInputElement>('[data-testid="stdio-args"]'), '--flag value "quoted arg"');
    fill(q<HTMLInputElement>('[data-testid="stdio-cwd"]'), "/opt/servers");
    fill(q<HTMLTextAreaElement>('[data-testid="stdio-env"]'), "MCP_LOG_LEVEL=debug\nAPI_KEY=secret=with=equals");

    act(() => q<HTMLFormElement>("form.panel").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await flush();
    await flush();

    const call = fetchSpy.mock.calls.find(([input, init]) => String(input).endsWith("/api/v1/servers") && (init as RequestInit | undefined)?.method === "POST");
    expect(call).toBeDefined();
    const payload = JSON.parse((call![1] as RequestInit).body as string);
    expect(payload.displayName).toBe("Local stdio server");
    expect(payload.transport).toBe("stdio");
    expect(payload.command).toBe("/opt/servers/echo");
    expect(payload.args).toEqual(["--flag", "value", "quoted arg"]);
    expect(payload.cwd).toBe("/opt/servers");
    expect(payload.env).toEqual({ MCP_LOG_LEVEL: "debug", API_KEY: "secret=with=equals" });
    expect(payload.endpoint).toBeNull();
  });
});
