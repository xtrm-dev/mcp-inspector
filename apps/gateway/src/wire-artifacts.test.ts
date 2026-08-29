import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSdkAdapter } from "@mcp-inspector-x/protocol";
import { openStorage, type Storage } from "@mcp-inspector-x/storage";
import { startDemoMcp, type DemoMcp } from "./demo-mcp";
import { buildGatewayApp } from "./routes";
import { createServerManager, type ServerManager } from "./servers";
import { createSecretsRegistry, type SecretsRegistry } from "./secrets";

interface CallResponse {
  executionId: string;
  status: string;
  evidenceRefs: Array<{ id: string; kind: string; artifactRef: string }>;
}

// Integration: a real streamable-http tools/call round produces BOTH a
// raw_request AND a raw_response artifact in the execution's evidence store,
// matching the shape stdio-proxy uses (see stdio-proxy.test.ts). The
// existing ProtocolEvidence-summary evidence row stays put — the wire pair
// is additive, not a replacement.
describe("wire recorder → raw_request + raw_response evidence artifacts", () => {
  let demo: DemoMcp;
  let adapter: ReturnType<typeof createSdkAdapter>;
  let app: ReturnType<typeof buildGatewayApp>;
  let storage: Storage;
  let serverManager: ServerManager;
  let secrets: SecretsRegistry;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "mix-wire-artifacts-"));
    storage = openStorage({ dataDir });
    demo = await startDemoMcp();
    secrets = createSecretsRegistry({ storage });
    adapter = createSdkAdapter({ redact: (s) => secrets.scrub(s) });
    serverManager = createServerManager({ storage, adapter, secrets });
    const demoDef = storage.servers.upsertById({
      id: "demo",
      displayName: "Demo",
      transport: "streamable-http",
      endpoint: demo.url,
      protocolPolicy: "modern",
    });
    await serverManager.connect(demoDef);
    app = buildGatewayApp({ adapter, storage, serverManager, secrets });
  }, 20_000);

  afterAll(async () => {
    for (const b of serverManager?.bindings() ?? []) {
      await adapter?.disconnect(b.descriptor.id).catch(() => {});
    }
    await demo?.close();
    storage?.close();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  it("POST /servers/:id/tools/:name/call persists raw_request + raw_response alongside the evidence summary", async () => {
    const r = await app.request("/api/v1/servers/demo/tools/add_numbers/call", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ arguments: { a: 2, b: 3 } }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as CallResponse;
    expect(body.status).toBe("complete");

    // Additive: the existing ProtocolEvidence summary row still appears,
    // AND both wire rows appear. Order in the response mirrors persistence.
    const kinds = body.evidenceRefs.map((e) => e.kind);
    expect(kinds).toContain("raw_request");
    expect(kinds).toContain("raw_response");
    expect(kinds.filter((k) => k === "raw_response").length).toBeGreaterThanOrEqual(2);

    const rawRequestRef = body.evidenceRefs.find((e) => e.kind === "raw_request");
    expect(rawRequestRef).toBeDefined();
    const wireResponseRef = body.evidenceRefs
      .filter((e) => e.kind === "raw_response")
      .at(-1);
    expect(wireResponseRef).toBeDefined();

    // Read the raw_request artifact and confirm it looks like an HTTP
    // request record with a JSON-RPC tools/call body.
    const reqBytes = storage.artifacts.getBytes(rawRequestRef!.artifactRef);
    const reqRecord = JSON.parse(new TextDecoder().decode(reqBytes)) as {
      method: string;
      url: string;
      headers: Record<string, string>;
      bodyBase64: string | null;
    };
    expect(reqRecord.method).toBe("POST");
    expect(reqRecord.url.startsWith(demo.url)).toBe(true);
    expect(reqRecord.bodyBase64).not.toBeNull();
    const decodedReqBody = Buffer.from(reqRecord.bodyBase64!, "base64").toString("utf8");
    expect(decodedReqBody).toContain('"method":"tools/call"');
    expect(decodedReqBody).toContain('"name":"add_numbers"');

    // The response artifact carries the server's status + body bytes.
    const resBytes = storage.artifacts.getBytes(wireResponseRef!.artifactRef);
    const resRecord = JSON.parse(new TextDecoder().decode(resBytes)) as {
      status: number;
      headers: Record<string, string>;
      bodyBase64: string | null;
      streamMarks: Array<{ event: string }>;
    };
    expect(resRecord.status).toBe(200);
    expect(resRecord.bodyBase64).not.toBeNull();
    expect(resRecord.streamMarks[0]?.event).toBe("open");
    expect(resRecord.streamMarks.at(-1)?.event).toBe("end");
  });
});
