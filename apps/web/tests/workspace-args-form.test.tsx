/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSdkAdapter } from "@mcp-inspector-x/protocol";
import { openStorage, type Storage } from "@mcp-inspector-x/storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildGatewayApp } from "../../gateway/src/routes";
import { createSecretsRegistry } from "../../gateway/src/secrets";
import { createServerManager } from "../../gateway/src/servers";
import { App } from "../src/app";

// mix-hhj: regression guard. A workspace node whose capability declares an
// input schema with a required field must (1) render a form derived from
// that schema on Run, (2) refuse to POST /run while the required field is
// empty, and (3) on submit PATCH the node's argumentsJson AND fire /run
// with the resolved args — proving the run does not land with `{}`.
const TOOL_NAME = "get_bullets";
const TOOL_SCHEMA = {
  type: "object" as const,
  // `minItems: 1` gates rjsf's helpful default (an empty array satisfies
  // `required: ["ids"]` on its own, which would let Run fire with `ids:
  // []` — the exact "empty args" regression this bead is guarding).
  properties: { ids: { type: "array" as const, items: { type: "string" as const }, minItems: 1 } },
  required: ["ids"],
};

let container: HTMLDivElement;
let root: Root;
let storage: Storage;
let dataDir: string;
let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "mix-web-args-"));
  storage = openStorage({ dataDir });
  storage.servers.upsertById({
    id: "srv-mercury",
    displayName: "Mercury",
    transport: "streamable-http",
    endpoint: "http://127.0.0.1:9/mcp",
    protocolPolicy: "modern",
  });
  const workspace = storage.workspaces.create({ id: "ws-args", name: "Args" });
  storage.workspaceNodes.create({
    id: "node-bullets",
    workspaceId: workspace.id,
    serverId: "srv-mercury",
    capabilityId: `srv-mercury::tool::${TOOL_NAME}`,
    presentation: "expanded",
    // No argumentsJson — matches the modal-add path that lands nodes with `{}`.
  });

  const adapter = createSdkAdapter();
  const secrets = createSecretsRegistry({ storage });
  const serverManager = createServerManager({ storage, adapter, secrets });
  const gateway = buildGatewayApp({ adapter, storage, serverManager, secrets });

  fetchSpy = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, "http://localhost");
    // The srv-mercury server is not actually connected. Stub the /tools
    // endpoint so the SPA can resolve the input schema without a live MCP
    // connection — the rest still hits the real gateway.
    if (url.pathname === "/api/v1/servers/srv-mercury/tools") {
      return new Response(JSON.stringify({ tools: [{ name: TOOL_NAME, inputSchema: TOOL_SCHEMA }] }), {
        headers: { "content-type": "application/json" },
      });
    }
    return gateway.request(`${url.pathname}${url.search}`, init);
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
  storage.close();
  rmSync(dataDir, { recursive: true, force: true });
});

async function flush() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

function findRunCall() {
  return fetchSpy.mock.calls.find(
    ([input, init]) => String(input).endsWith("/api/v1/workspaces/ws-args/run")
      && (init as RequestInit | undefined)?.method === "POST",
  );
}

function findPatchCall() {
  return fetchSpy.mock.calls.find(
    ([input, init]) => String(input).endsWith("/api/v1/workspaces/ws-args/nodes/node-bullets")
      && (init as RequestInit | undefined)?.method === "PATCH",
  );
}

describe("workspace tool-call arguments (mix-hhj)", () => {
  it("refuses to run until required args are filled, then PATCHes argumentsJson and fires /run", async () => {
    await act(async () => root.render(<App />));
    await flush();
    await flush();
    await flush();

    // The Inputs tab exists and renders a form derived from the tool schema.
    const inputsTab = container.querySelector('[data-testid="inspection-tab-inputs-node-bullets"]');
    expect(inputsTab).not.toBeNull();
    act(() => (inputsTab as HTMLElement).click());
    await flush();
    expect(container.querySelector('[data-testid="inputs-tab-node-bullets"]')).not.toBeNull();

    // Empty `ids` (required) → the per-node Run button is disabled and
    // clicking Save & Run in the form is also refused; no POST /run yet.
    const cardRun = container.querySelector<HTMLButtonElement>('[data-testid="run-node-node-bullets"]');
    expect(cardRun?.disabled).toBe(true);
    const submit = container.querySelector<HTMLButtonElement>('[data-testid="inputs-run-node-bullets"]');
    expect(submit?.disabled).toBe(true);
    act(() => submit!.click());
    await flush();
    expect(findRunCall()).toBeUndefined();
    expect(findPatchCall()).toBeUndefined();

    // Fill the required `ids` array with one string via the raw-JSON tab
    // (rjsf's array widget needs multi-click affordances rjsf-core wires up
    // for us; the raw tab is the same code path that persists the value
    // through SchemaForm's onChange with valid=true).
    const rawTab = container.querySelector<HTMLButtonElement>('.inputs-tab .schema-form .local-tabs button:nth-of-type(2)');
    expect(rawTab).not.toBeNull();
    act(() => rawTab!.click());
    await flush();
    const textarea = container.querySelector<HTMLTextAreaElement>('.inputs-tab .raw-json-editor textarea');
    expect(textarea).not.toBeNull();
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(textarea, JSON.stringify({ ids: ["a"] }));
      textarea!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flush();

    const enabledSubmit = container.querySelector<HTMLButtonElement>('[data-testid="inputs-run-node-bullets"]');
    expect(enabledSubmit?.disabled).toBe(false);
    act(() => enabledSubmit!.click());
    await flush();
    await flush();

    const patchCall = findPatchCall();
    expect(patchCall).toBeDefined();
    const patchBody = JSON.parse((patchCall![1] as RequestInit).body as string);
    expect(JSON.parse(patchBody.argumentsJson)).toEqual({ ids: ["a"] });

    const runCall = findRunCall();
    expect(runCall).toBeDefined();
    expect(JSON.parse((runCall![1] as RequestInit).body as string)).toEqual({ nodeIds: ["node-bullets"] });

    // The persisted node now carries the real args instead of `{}` —
    // subsequent Run All / Run selected reuse them.
    expect(storage.workspaceNodes.get("node-bullets")?.argumentsJson).toBe(JSON.stringify({ ids: ["a"] }));
  });
});
