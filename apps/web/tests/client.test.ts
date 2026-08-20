import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  callTool,
  createServer,
  getArtifactPage,
  listExecutions,
  listServers,
  runWorkspaceApi,
} from "../src/api/client";

function mockFetchOnce(status: number, body: unknown, contentType = "application/json") {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => contentType },
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("api/client", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("listServers GETs /api/v1/servers and returns parsed body", async () => {
    const fetchMock = mockFetchOnce(200, { servers: [{ id: "demo" }] });
    const result = await listServers();
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/servers", expect.objectContaining({}));
    expect(result.servers).toEqual([{ id: "demo" }]);
  });

  it("createServer POSTs the input as JSON", async () => {
    const fetchMock = mockFetchOnce(201, { server: { id: "s1" }, connected: false, negotiation: null });
    await createServer({ displayName: "Demo", transport: "streamable-http", connectNow: false });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/v1/servers");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toMatchObject({ displayName: "Demo" });
  });

  it("callTool posts to the tool-call endpoint and returns the execution envelope", async () => {
    const envelope = { executionId: "exec1", value: { ok: true }, evidence: {}, suggestedRenderer: "json-tree" };
    const fetchMock = mockFetchOnce(200, envelope);
    const result = await callTool("demo", "echo", { text: "hi" });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/v1/servers/demo/tools/echo/call");
    expect(result).toEqual(envelope);
  });

  it("runWorkspaceApi posts nodeIds/concurrency and returns the run result", async () => {
    const runResult = { runId: "r1", workspaceId: "w1", captureSessionId: "c1", agentRunId: "a1", concurrency: 4, nodes: [] };
    mockFetchOnce(200, runResult);
    const result = await runWorkspaceApi("w1", { concurrency: 2 });
    expect(result).toEqual(runResult);
  });

  it("listExecutions builds a query string from options", async () => {
    const fetchMock = mockFetchOnce(200, { executions: [] });
    await listExecutions({ limit: 10, capabilityId: "demo::tool::echo" });
    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).toContain("limit=10");
    expect(url).toContain("capabilityId=demo");
  });

  it("getArtifactPage builds offset/limit/kind query params", async () => {
    const page = { artifactRef: "sha1", offset: 200, limit: 200, hasMore: true, lines: ["a", "b"] };
    const fetchMock = mockFetchOnce(200, page);
    const result = await getArtifactPage("sha1", { offset: 200, limit: 200, kind: "ndjson" });
    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).toBe("/api/v1/artifacts/sha1/page?offset=200&limit=200&kind=ndjson");
    expect(result.hasMore).toBe(true);
  });

  it("throws ApiError with status + body on a non-ok response", async () => {
    mockFetchOnce(404, { error: "unknown server 'x'" });
    const err = await callTool("x", "y", {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(404);
  });
});
