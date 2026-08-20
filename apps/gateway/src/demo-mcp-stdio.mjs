#!/usr/bin/env node
// Tiny standalone entry (plain JS, no TS build step needed) that serves the
// same add_numbers tool as demo-mcp.ts, but over stdio instead of
// streamable-http. Spawned by the runner (never the gateway — ADR-0003) in
// apps/gateway/src/stdio-mcp.test.ts to prove the runner-spawned stdio MCP
// path end-to-end.
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

function buildDemoServer() {
  const mcp = new McpServer({ name: "mcp-inspector-x-demo-stdio", version: "0.0.1" });
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
  return mcp;
}

serveStdio(buildDemoServer);
