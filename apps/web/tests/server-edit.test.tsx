/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ServersPage } from "../src/pages/ServersPage";
import type { ServerDetail } from "../src/api/types";

let container: HTMLDivElement;
let root: Root;
let fetchSpy: ReturnType<typeof vi.fn>;
let serverDetail: ServerDetail;

function summary(): Partial<ServerDetail> {
  return {
    id: serverDetail.id,
    displayName: serverDetail.displayName,
    transport: serverDetail.transport,
    endpoint: serverDetail.endpoint,
    protocolPolicy: serverDetail.protocolPolicy,
    disabled: serverDetail.disabled,
    createdAt: serverDetail.createdAt,
    updatedAt: serverDetail.updatedAt,
    connected: true,
    negotiation: null,
  };
}

function baseDetail(): ServerDetail {
  return {
    id: "srv-1",
    displayName: "Demo",
    transport: "streamable-http",
    endpoint: "http://127.0.0.1:37233/",
    command: null,
    args: null,
    cwd: null,
    env: null,
    credentialRefId: null,
    headerCredentials: null,
    protocolPolicy: "modern",
    disabled: false,
    createdAt: "2026-08-29T00:00:00.000Z",
    updatedAt: "2026-08-29T00:00:00.000Z",
    connected: true,
    negotiation: null,
  };
}

beforeEach(() => {
  serverDetail = baseDetail();
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
    if (url.pathname === "/api/v1/servers" && method === "GET") return respond({ servers: [summary()] });
    if (url.pathname === "/api/v1/servers" && method === "POST") return respond({ server: { ...serverDetail, id: "srv-new" }, connected: false, negotiation: null });
    const idMatch = url.pathname.match(/^\/api\/v1\/servers\/([^/]+)$/);
    if (idMatch && method === "GET") return respond({ server: { ...serverDetail, connected: true, negotiation: null } });
    if (idMatch && method === "PATCH") {
      const patch = JSON.parse((init?.body as string) || "{}");
      serverDetail = { ...serverDetail, ...patch };
      return respond({ server: { ...serverDetail, connected: true, negotiation: null } });
    }
    if (url.pathname === "/api/v1/credentials" && method === "POST") return respond({ credentialRef: { id: "cred-new" } });
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

function editButton(): HTMLButtonElement {
  const btn = [...q<HTMLTableRowElement>("tbody tr").querySelectorAll("button")].find(
    (b) => b.textContent === "Edit",
  );
  if (!btn) throw new Error("no Edit button in server row");
  return btn;
}

function submitForm() {
  act(() =>
    q<HTMLFormElement>("form.panel").dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    ),
  );
}

function patchBody(): Record<string, unknown> {
  const patchCall = fetchSpy.mock.calls.find(
    ([input, init]) =>
      String(input).endsWith("/api/v1/servers/srv-1") &&
      (init as RequestInit | undefined)?.method === "PATCH",
  );
  expect(patchCall).toBeDefined();
  return JSON.parse((patchCall![1] as RequestInit).body as string) as Record<string, unknown>;
}

describe("Server edit mode", () => {
  it("connected server → Edit → form prefilled (non-secret) → change displayName → PATCH → row re-renders", async () => {
    await act(async () => root.render(<ServersPage />));
    await flush();

    // Row exposes an Edit affordance. FAILS today: rows only render
    // Connect / Disconnect / Test / Delete.
    expect(editButton()).toBeDefined();

    act(() => editButton().click());
    await flush();

    // Form prefilled with non-secret fields; secret fields stay blank.
    const nameInput = q<HTMLInputElement>("form.panel input[required]");
    expect(nameInput.value).toBe("Demo");
    expect(q<HTMLInputElement>('[data-testid="server-endpoint"]').value).toBe(
      "http://127.0.0.1:37233/",
    );
    expect(q<HTMLButtonElement>('form.panel button[type="submit"]').textContent).toBe(
      "Save changes",
    );

    fill(nameInput, "Demo Two");
    submitForm();
    await flush();
    await flush();

    const patchCall = fetchSpy.mock.calls.find(
      ([input, init]) =>
        String(input).endsWith("/api/v1/servers/srv-1") &&
        (init as RequestInit | undefined)?.method === "PATCH",
    );
    expect(patchCall).toBeDefined();
    const patch = JSON.parse((patchCall![1] as RequestInit).body as string);
    expect(patch.displayName).toBe("Demo Two");
    // unchanged/secret fields do not travel in the PATCH
    expect(patch.credentialRefId).toBeUndefined();

    // Row re-renders with the new name after refresh.
    expect(container.textContent).toContain("Demo Two");
  });

  it("Edit → change bearer → PATCH new credentialRefId (no plaintext in PATCH)", async () => {
    serverDetail.credentialRefId = "cred-old";
    await act(async () => root.render(<ServersPage />));
    await flush();

    act(() => editButton().click());
    await flush();

    // Auth derived from the existing binding; secret value never prefilled.
    expect(q<HTMLSelectElement>('[data-testid="auth-kind"]').value).toBe("bearer");
    const secret = q<HTMLInputElement>("form.panel input[type='password']");
    expect(secret.value).toBe("");
    expect(secret.placeholder).toBe("keep existing");

    fill(secret, "rotated-token");
    submitForm();
    await flush();
    await flush();

    const credCall = fetchSpy.mock.calls.find(
      ([input, init]) =>
        String(input).endsWith("/api/v1/credentials") &&
        (init as RequestInit | undefined)?.method === "POST",
    );
    expect(credCall).toBeDefined();
    expect(JSON.parse((credCall![1] as RequestInit).body as string).value).toBe("rotated-token");

    const patchCall = fetchSpy.mock.calls.find(
      ([input, init]) =>
        String(input).endsWith("/api/v1/servers/srv-1") &&
        (init as RequestInit | undefined)?.method === "PATCH",
    );
    expect(patchCall).toBeDefined();
    const patch = JSON.parse((patchCall![1] as RequestInit).body as string);
    // New credential ref is what the gateway will use on next reconnect /
    // capability list fetch.
    expect(patch.credentialRefId).toBe("cred-new");
    expect(patch.displayName).toBeUndefined();
    expect(JSON.stringify(patch)).not.toContain("rotated-token");
  });

  it("stdio edit never prefills env credential values — keep-existing placeholder, no env PATCH", async () => {
    serverDetail = {
      ...baseDetail(),
      transport: "stdio",
      endpoint: null,
      command: "/opt/srv/echo",
      args: ["--flag"],
      cwd: "/opt/srv",
      env: { MY_API_KEY: "TOP-SECRET" },
    };
    await act(async () => root.render(<ServersPage />));
    await flush();

    act(() => editButton().click());
    await flush();

    // Non-secret stdio fields are prefilled…
    expect(q<HTMLInputElement>('[data-testid="stdio-command"]').value).toBe("/opt/srv/echo");
    expect(q<HTMLInputElement>('[data-testid="stdio-cwd"]').value).toBe("/opt/srv");
    // …env values are NOT.
    const envTextarea = q<HTMLTextAreaElement>('[data-testid="stdio-env"]');
    expect(envTextarea.value).toBe("");
    expect(envTextarea.placeholder).toContain("keep existing");

    // Submit without touching secrets → no PATCH at all, and no request
    // body ever carries the plaintext env value.
    submitForm();
    await flush();
    await flush();
    const writeCalls = fetchSpy.mock.calls.filter(
      ([, init]) => init && ["POST", "PATCH"].includes(String((init as RequestInit).method)),
    );
    expect(writeCalls.length).toBe(0);
    for (const [, init] of writeCalls) {
      expect(String((init as RequestInit).body)).not.toContain("TOP-SECRET");
    }
  });

  it("switching bearer → custom header PATCHes the new header map and nulls the old bearer", async () => {
    serverDetail = { ...baseDetail(), credentialRefId: "cred-old" };
    await act(async () => root.render(<ServersPage />));
    await flush();

    act(() => editButton().click());
    await flush();

    fill(q<HTMLSelectElement>('[data-testid="auth-kind"]'), "header");
    fill(q<HTMLInputElement>("form.panel input[type='password']"), "new-token");
    submitForm();
    await flush();
    await flush();

    const patch = patchBody();
    // Only the header binding remains — the revoked bearer must not keep
    // being sent by the gateway on reconnect (dual-auth bug). FAILS pre-fix:
    // credentialRefId key absent, so cred-old stays in storage.
    expect(patch.headerCredentials).toEqual({ "X-API-Key": "cred-new" });
    expect(patch.credentialRefId).toBeNull();
  });

  it("choosing Auth=None in edit mode removes the held binding (credentialRefId → null)", async () => {
    serverDetail = { ...baseDetail(), credentialRefId: "cred-old" };
    await act(async () => root.render(<ServersPage />));
    await flush();

    act(() => editButton().click());
    await flush();

    fill(q<HTMLSelectElement>('[data-testid="auth-kind"]'), "none");
    submitForm();
    await flush();
    await flush();

    expect(patchBody().credentialRefId).toBeNull(); // FAILS pre-fix: no PATCH at all
  });

  it("switching auth kind without entering a value surfaces a validation error, not a silent no-op", async () => {
    serverDetail = { ...baseDetail(), credentialRefId: "cred-old" };
    await act(async () => root.render(<ServersPage />));
    await flush();

    act(() => editButton().click());
    await flush();

    fill(q<HTMLSelectElement>('[data-testid="auth-kind"]'), "header"); // value auto-cleared
    submitForm();
    await flush();
    await flush();

    expect(container.textContent).toContain("auth value is required"); // FAILS pre-fix: silent no-op
    expect(fetchSpy.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "PATCH")).toBe(false);
  });
});
