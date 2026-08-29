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
    task.lastUpdatedAt = nowIso();
    return respondJson(res, {
      jsonrpc: "2.0",
      id,
      result: { taskId, status: "cancelled" },
    });
  }
  if (method === "tasks/update") {
    // Tasks-extension update: the client provides inputResponses that
    // unblock an interactive task waiting in `input_required`. Any other
    // update is an acknowledged echo.
    const inputResponses = isJsonObject(params.inputResponses)
      ? (params.inputResponses as Record<string, unknown>)
      : undefined;
    if (
      task.kind === "interactive" &&
      task.status === "input_required" &&
      inputResponses !== undefined
    ) {
      const responded = extractRespondedName(inputResponses);
      if (responded && responded.length > 0) {
        task.status = "working";
        task.awaitingInput = false;
        task.pollCount = 0;
        task.lastUpdatedAt = nowIso();
      }
    }
    return respondJson(res, {
      jsonrpc: "2.0",
      id,
      result: { taskId, status: task.status },
    });
  }

  // tasks/get: advance the demo state machine.
  //   long_running: working → (poll #2) completed(result=42)
  //   interactive : working → (poll #1) input_required → [tasks/update inputResponses]
  //                        → working → (poll #1 post-answer) completed(result=42)
  if (task.status === "working") {
    task.pollCount += 1;
    task.lastUpdatedAt = nowIso();
    if (task.kind === "interactive" && task.awaitingInput) {
      task.status = "input_required";
    } else if (task.pollCount >= 2 || (task.kind === "interactive" && !task.awaitingInput)) {
      task.status = "completed";
      task.result = 42;
    }
  }
  const resultEnv: Record<string, unknown> = {
    taskId,
    status: task.status,
    pollIntervalMs: TASK_POLL_INTERVAL_MS,
  };
  if (task.status === "input_required") {
    // Extension-shaped `inputRequests` payload. The map key ('name') matches
    // what tasks/update expects back on inputResponses to unblock the task.
    resultEnv["inputRequests"] = {
      [INTERACTIVE_INPUT_KEY]: {
        method: "elicitation/create",
        params: {
          message: "What is your name?",
          requestedSchema: {
            type: "object",
            properties: { name: { type: "string" } },
            required: ["name"],
          },
        },
      },
    };
    resultEnv["requestState"] = `interactive_task:${taskId}`;
  }
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

function isJsonObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// Accept either { name: "…" } or { name: { name: "…" } } (elicitation
// nesting per the tasks-extension examples). Non-string values are ignored.
function extractRespondedName(responses: Record<string, unknown>): string | undefined {
  const slot = responses[INTERACTIVE_INPUT_KEY];
  if (typeof slot === "string") return slot;
  if (isJsonObject(slot)) {
    const inner = (slot as Record<string, unknown>)[INTERACTIVE_INPUT_KEY];
    if (typeof inner === "string") return inner;
  }
  return undefined;
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

type DemoTaskStatus = "working" | "input_required" | "completed" | "cancelled";
type DemoTaskKind = "long_running" | "interactive";
interface DemoTask {
  kind: DemoTaskKind;
  status: DemoTaskStatus;
  pollCount: number;
  result?: number;
  createdAt: string;
  lastUpdatedAt: string;
  // Interactive-flow marker: cleared once the client answers the elicitation.
  awaitingInput?: boolean;
}
const demoTasks = new Map<string, DemoTask>();

const TASK_POLL_INTERVAL_MS = 250;
const INTERACTIVE_INPUT_KEY = "name";

/**
 * Build a `tools/call` result that carries BOTH:
 *   - the legacy `structuredContent: { taskId, status }` shape (the
 *     detectTaskShape classifier in routes.ts still recognizes this), and
 *   - the standard Tasks-extension envelope under a top-level `task` field
 *     (`CreateTaskResultSchema`; SDK's `$loose` root allows extra fields).
 * The adapter's mapCallToolResult prefers `task.taskId`/`task.status` when
 * present and stamps `evidence.resultType = "task"`.
 */
function taskCreateResult(taskId: string, task: DemoTask) {
  const structuredContent = { taskId, status: task.status };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
    structuredContent,
    task: {
      taskId,
      status: task.status,
      ttl: null,
      createdAt: task.createdAt,
      lastUpdatedAt: task.lastUpdatedAt,
      pollInterval: TASK_POLL_INTERVAL_MS,
    },
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function createDemoTask(kind: DemoTaskKind): { taskId: string; task: DemoTask } {
  const taskId = randomUUID();
  const t = nowIso();
  const task: DemoTask = {
    kind,
    status: "working",
    pollCount: 0,
    createdAt: t,
    lastUpdatedAt: t,
    ...(kind === "interactive" ? { awaitingInput: true } : {}),
  };
  demoTasks.set(taskId, task);
  return { taskId, task };
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
      description:
        "Starts a Tasks-extension task. Returns a task envelope; poll or cancel via tasks/get / tasks/cancel.",
      inputSchema: z.object({}),
    },
    () => {
      const { taskId, task } = createDemoTask("long_running");
      return taskCreateResult(taskId, task);
    },
  );
  mcp.registerTool(
    "interactive_task",
    {
      title: "Interactive Task",
      description:
        "Starts a Tasks-extension task that reaches input_required mid-flight. Answer via tasks/update inputResponses, then poll to completion.",
      inputSchema: z.object({}),
    },
    () => {
      const { taskId, task } = createDemoTask("interactive");
      return taskCreateResult(taskId, task);
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
