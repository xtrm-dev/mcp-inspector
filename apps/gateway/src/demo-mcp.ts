import { createServer, type Server as HttpServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import {
  McpServer,
  createMcpHandler,
  type McpHttpHandler,
} from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { MODERN_PROTOCOL_VERSION } from "@mcp-inspector-x/protocol";

/**
 * Bring-your-own-demo: a self-contained 2026-07-28 MCP server the gateway
 * spawns in-process at boot so the web UI has real live data on first run.
 *
 * ponytail: hardcoded add_numbers + slow_echo. Real product wiring for
 * external servers (env var / config file, multi-server, auth) is a
 * separate slice — this exists so the first-run experience is not empty.
 */
export interface DemoMcp {
  readonly url: string;
  close(): Promise<void>;
}

export async function startDemoMcp(): Promise<DemoMcp> {
  const handler: McpHttpHandler = createMcpHandler(() => buildDemoServer());
  const nodeHandler = toNodeHandler(handler);
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void nodeHandler(req as unknown as Parameters<typeof nodeHandler>[0], res);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("demo-mcp: no bound address");
  const url = `http://127.0.0.1:${addr.port}/`;
  return {
    url,
    async close() {
      await handler.close();
      await closeHttpServer(server);
    },
  };
}

function closeHttpServer(server: HttpServer): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function buildDemoServer(): McpServer {
  const mcp = new McpServer(
    { name: "mcp-inspector-x-demo", version: "0.0.1" },
    { supportedProtocolVersions: [MODERN_PROTOCOL_VERSION] },
  );
  mcp.registerTool(
    "add_numbers",
    {
      title: "Add Numbers",
      description: "Return the sum of a and b",
      inputSchema: z.object({ a: z.number(), b: z.number() }),
      outputSchema: z.object({ sum: z.number() }),
    },
    async ({ a, b }) => ({
      content: [{ type: "text", text: JSON.stringify({ sum: a + b }) }],
      structuredContent: { sum: a + b },
    }),
  );
  mcp.registerTool(
    "slow_echo",
    {
      title: "Slow Echo",
      description: "Sleep for delayMs then echo value",
      inputSchema: z.object({ value: z.number(), delayMs: z.number() }),
      outputSchema: z.object({ value: z.number() }),
    },
    async ({ value, delayMs }) => {
      await new Promise((r) => setTimeout(r, delayMs));
      return {
        content: [{ type: "text", text: JSON.stringify({ value }) }],
        structuredContent: { value },
      };
    },
  );
  return mcp;
}
