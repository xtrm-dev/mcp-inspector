import { createServer, type Server as HttpServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  McpServer,
  createMcpHandler,
  inputRequired,
  acceptedContent,
  type McpHttpHandler,
} from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { MODERN_PROTOCOL_VERSION } from "@mcp-inspector-x/protocol";

/**
 * Bring-your-own-demo: a self-contained 2026-07-28 MCP server the gateway
 * spawns in-process at boot so the web UI has real live data on first run.
 *
 * ponytail: hardcoded add_numbers + slow_echo + interactive_greet +
 * long_running_task. Real product wiring for external servers (env var /
 * config file, multi-server, auth) is a separate slice — this exists so the
 * first-run experience is not empty.
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

type DemoTaskStatus = "working" | "completed" | "cancelled";
interface DemoTask {
  status: DemoTaskStatus;
  pollCount: number;
  result?: number;
}
// Module-level: createMcpHandler builds a fresh McpServer per HTTP request
// (stateless-per-request), so task bookkeeping across poll rounds has to
// live outside any single McpServer instance.
const demoTasks = new Map<string, DemoTask>();

function taskResult(taskId: string, status: DemoTaskStatus, result?: number) {
  const structuredContent =
    result === undefined ? { taskId, status } : { taskId, status, result };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
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
  // interactive_greet — MRTR demo tool: round 1 has no `name` input and no
  // fulfilled elicitation yet, so it returns input_required asking for one;
  // round 2 (the client's continuation carrying the same requestState plus
  // { name: <answer> } in inputResponses) completes with a greeting.
  mcp.registerTool(
    "interactive_greet",
    {
      title: "Interactive Greet",
      description: "Elicits a name, then greets it. Exercises the MRTR input_required round-trip.",
      inputSchema: z.object({}),
      outputSchema: z.object({ greeting: z.string() }),
    },
    (_args, ctx) => {
      const answer = acceptedContent<{ name: string }>(ctx.mcpReq.inputResponses, "name");
      if (typeof answer?.name !== "string" || answer.name.length === 0) {
        return inputRequired({
          requestState: "interactive_greet:v1",
          inputRequests: {
            name: inputRequired.elicit({
              message: "What is your name?",
              requestedSchema: z.object({ name: z.string() }),
            }),
          },
        });
      }
      const greeting = `Hello, ${answer.name}`;
      return {
        content: [{ type: "text", text: greeting }],
        structuredContent: { greeting },
      };
    },
  );
  // long_running_task — Tasks-lifecycle demo tool. There is no live
  // wire-level Task poll/get/cancel in the installed SDK (see the
  // TASKS_EXTENSION_KEY doc comment in packages/protocol/src/index.ts), so
  // this models the lifecycle as ordinary follow-up tools/call rounds
  // carrying the taskId back: no taskId → start a task; taskId + cancel →
  // cancel it; taskId alone → poll (completes after 2 polls, deterministic
  // for tests — no real timers).
  mcp.registerTool(
    "long_running_task",
    {
      title: "Long Running Task",
      description: "Starts a task; poll or cancel it by taskId on follow-up calls.",
      inputSchema: z.object({ taskId: z.string().optional(), cancel: z.boolean().optional() }),
      outputSchema: z.object({
        taskId: z.string(),
        status: z.enum(["working", "completed", "cancelled"]),
        result: z.number().optional(),
      }),
    },
    ({ taskId, cancel }) => {
      if (!taskId) {
        const id = randomUUID();
        demoTasks.set(id, { status: "working", pollCount: 0 });
        return taskResult(id, "working");
      }
      const task = demoTasks.get(taskId);
      if (!task) throw new Error(`long_running_task: unknown taskId '${taskId}'`);
      if (cancel) {
        task.status = "cancelled";
        return taskResult(taskId, "cancelled");
      }
      if (task.status !== "working") {
        return taskResult(taskId, task.status, task.result);
      }
      task.pollCount += 1;
      if (task.pollCount >= 2) {
        task.status = "completed";
        task.result = 42;
        return taskResult(taskId, "completed", 42);
      }
      return taskResult(taskId, "working");
    },
  );
  mcp.registerResource(
    "readme",
    "mix://demo/readme",
    {
      title: "Demo README",
      description: "A static resource exposed by the built-in demo server",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "text/markdown",
          text: "# MCP Inspector X demo\n\nThis is a demo resource.\n",
        },
      ],
    }),
  );
  mcp.registerPrompt(
    "greeting",
    {
      title: "Greeting",
      description: "Compose a friendly greeting for a named person.",
      argsSchema: z.object({ name: z.string() }),
    },
    ({ name }) => ({
      messages: [
        {
          role: "user",
          content: { type: "text", text: `Please greet ${name} in one short sentence.` },
        },
      ],
    }),
  );
  return mcp;
}
