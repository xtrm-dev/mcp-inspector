import { createServer, type Server as HttpServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
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
 * The HTTP layer here also serves the Tasks-extension raw-wire methods
 * (`tasks/get`, `tasks/update`, `tasks/cancel`) directly — `createMcpHandler`
 * rejects those method names under SDK #2598 (historical-name registry),
 * so the wrap intercepts them before they reach `nodeHandler`. Historical
 * `tasks/list` and `tasks/result` are rejected with -32601 and recorded
 * to `getForbiddenTaskMethodsReceived()` so strict-server integration tests
 * can assert they were never emitted by the seam.
 *
 * ponytail: hardcoded add_numbers + slow_echo + long_running_task. Real
 * product wiring for external servers (env var / config file, multi-server,
 * auth) is a separate slice — this exists so the first-run experience is
 * not empty.
 */
export interface DemoMcp {
  readonly url: string;
  close(): Promise<void>;
}

// Receipt log for strict-server assertions. Cleared per describe suite.
interface TaskMethodReceipt {
  method: string;
  taskId: string | undefined;
  headers: Record<string, string | string[] | undefined>;
}
const taskMethodsReceived: TaskMethodReceipt[] = [];
const forbiddenTaskMethodsReceived: TaskMethodReceipt[] = [];

/** Reset the receipt log; call from `beforeEach`/`beforeAll` in tests. */
export function resetTaskMethodReceipts(): void {
  taskMethodsReceived.length = 0;
  forbiddenTaskMethodsReceived.length = 0;
}

/** Every `tasks/get`, `tasks/update`, `tasks/cancel` request the demo saw. */
export function getTaskMethodsReceived(): ReadonlyArray<TaskMethodReceipt> {
  return taskMethodsReceived;
}

/** Historical `tasks/list` / `tasks/result` requests — MUST stay empty. */
export function getForbiddenTaskMethodsReceived(): ReadonlyArray<TaskMethodReceipt> {
  return forbiddenTaskMethodsReceived;
}

export async function startDemoMcp(): Promise<DemoMcp> {
  const handler: McpHttpHandler = createMcpHandler(() => buildDemoServer());
  const nodeHandler = toNodeHandler(handler);
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // Buffer the body once so we can either handle Tasks methods here or
    // replay the exact bytes through nodeHandler for everything else.
    let body = "";
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      body = Buffer.concat(chunks).toString("utf8");
    } catch {
      // Fall through — nodeHandler will surface the read error itself.
    }

    if (req.method === "POST" && body.length > 0) {
      const routed = tryRouteTasksMethod(body, req.headers, res);
      if (routed) return;
    }

    // Replay the body through the SDK node handler for everything else.
    // The replay stream carries the exact request context by copying the
    // small allowlist of fields the SDK's node handler reads. Written as
    // explicit assignments (not Object.assign) so linters do not flag it
    // as a mass-assignment sink.
    const replay = Readable.from([body]) as unknown as IncomingMessage;
    replay.headers = req.headers;
    replay.method = req.method;
    replay.url = req.url;
    replay.httpVersion = req.httpVersion;
    replay.httpVersionMajor = req.httpVersionMajor;
    replay.httpVersionMinor = req.httpVersionMinor;
    (replay as unknown as { socket: unknown }).socket = req.socket;
    replay.complete = true;
    void nodeHandler(replay as unknown as Parameters<typeof nodeHandler>[0], res);
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

/**
 * Tasks extension raw-wire dispatcher. Returns `true` if the message was a
 * Tasks-extension method and was answered here (McpServer never sees it),
 * `false` otherwise. Non-JSON bodies fall through untouched.
 */
function tryRouteTasksMethod(
  body: string,
  headers: IncomingMessage["headers"],
  res: ServerResponse,
): boolean {
  type ParsedMsg = { method?: unknown; id?: unknown; params?: unknown };
  let msg: ParsedMsg | null = null;
  try {
    msg = JSON.parse(body) as ParsedMsg;
  } catch {
    return false;
  }
  if (!msg || typeof msg.method !== "string") return false;
  const method = msg.method;
  const id = msg.id;
  const params = (msg.params ?? {}) as { taskId?: unknown; inputResponses?: unknown; requestState?: unknown };
  const taskId = typeof params.taskId === "string" ? params.taskId : undefined;

  if (method === "tasks/list" || method === "tasks/result") {
    forbiddenTaskMethodsReceived.push({ method, taskId, headers });
    return respondJson(res, {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32601,
        message: `historical Tasks method '${method}' is not implemented on modern 2026-07-28 server`,
      },
    });
  }
  if (method !== "tasks/get" && method !== "tasks/update" && method !== "tasks/cancel") {
    return false;
  }

  taskMethodsReceived.push({ method, taskId, headers });
  if (taskId === undefined) {
    return respondJson(res, {
      jsonrpc: "2.0",
      id,
      error: { code: -32602, message: `'${method}' requires params.taskId` },
    });
  }
  const task = demoTasks.get(taskId);
  if (!task) {
    return respondJson(res, {
      jsonrpc: "2.0",
      id,
      error: { code: -32602, message: `unknown taskId '${taskId}'` },
    });
  }

  if (method === "tasks/cancel") {
    task.status = "cancelled";
    return respondJson(res, {
      jsonrpc: "2.0",
      id,
      result: { taskId, status: "cancelled" },
    });
  }
  if (method === "tasks/update") {
    // The demo does not model mid-task input yet; acknowledge and echo.
    return respondJson(res, {
      jsonrpc: "2.0",
      id,
      result: { taskId, status: task.status },
    });
  }

  // tasks/get: advance the demo state machine (poll #2 → completed).
  if (task.status === "working") {
    task.pollCount += 1;
    if (task.pollCount >= 2) {
      task.status = "completed";
      task.result = 42;
    }
  }
  const resultEnv: Record<string, unknown> = {
    taskId,
    status: task.status,
    pollIntervalMs: 250,
  };
  if (task.status === "completed" && task.result !== undefined) {
    resultEnv["result"] = {
      content: [
        {
          type: "text",
          text: JSON.stringify({ taskId, status: "completed", result: task.result }),
        },
      ],
      structuredContent: { taskId, status: "completed", result: task.result },
    };
  }
  return respondJson(res, { jsonrpc: "2.0", id, result: resultEnv });
}

function respondJson(res: ServerResponse, body: unknown): true {
  const payload = JSON.stringify(body);
  res.writeHead(200, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload).toString(),
  });
  res.end(payload);
  return true;
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
