import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import {
  createSdkAdapter,
  type ProtocolNegotiation,
} from "@mcp-inspector-x/protocol";
import { openStorage, type Storage } from "@mcp-inspector-x/storage";
import { connectRunnerClient, type RunnerClient } from "@mcp-inspector-x/runner";
import { startDemoMcp, type DemoMcp } from "./demo-mcp";
import { buildGatewayApp } from "./routes";
import { createServerManager } from "./servers";
import { createSecretsRegistry } from "./secrets";

// Packaged builds ship the built web SPA as a sibling "web/" directory next
// to the bundled gateway entry point (see scripts/package.mjs + bin.mjs).
// Source/dev mode never sets this, so the dev workflow (Vite on :5174) is
// unaffected — this is additive, packaged-only behavior.
function mountWebAssets(app: ReturnType<typeof buildGatewayApp>): void {
  const webDist = process.env["MIX_WEB_DIST"];
  if (!webDist || !existsSync(webDist)) return;
  app.use("/assets/*", serveStatic({ root: webDist }));
  const indexHtml = serveStatic({ root: webDist, path: "index.html" });
  app.get("/", indexHtml);
  app.get("*", async (c, next) => {
    if (c.req.path.startsWith("/api/") || c.req.path === "/health") return next();
    return indexHtml(c, next);
  });
}

function defaultDataDir(): string {
  return process.env["MIX_DATA_DIR"] ?? join(homedir(), ".mcp-inspector-x");
}

// Wire the privileged runner when the supervisor exposes it via env
// (scripts/package-bin.mjs sets both). Without the runner the gateway
// still boots — but stdio transports, stdio-proxy capture, and the OS
// keychain secrets provider will fast-fail with "requires a privileged
// runner", matching source-tree behavior when the runner is absent.
async function maybeConnectRunner(): Promise<RunnerClient | undefined> {
  const socketPath = process.env["MIX_RUNNER_SOCKET"];
  if (!socketPath) return undefined;
  const tokenPath = process.env["MIX_RUNNER_TOKEN_PATH"];
  const token = process.env["MIX_RUNNER_TOKEN"];
  if (!tokenPath && !token) return undefined;
  try {
    return await connectRunnerClient(
      tokenPath !== undefined
        ? { socketPath, tokenPath }
        : { socketPath, token: token as string },
    );
  } catch (err) {
    console.error(
      "runner IPC unavailable at %s — stdio/stdio-proxy/os-keychain paths will fast-fail:",
      socketPath,
      err,
    );
    return undefined;
  }
}

async function main(): Promise<void> {
  const storage: Storage = openStorage({ dataDir: defaultDataDir() });
  storage.events.append({ kind: "gateway.boot", payload: { pid: process.pid } });

  const demo: DemoMcp = await startDemoMcp();
  const secrets = createSecretsRegistry({ storage });
  const adapter = createSdkAdapter({ redact: (s) => secrets.scrub(s) });
  const runnerClient = await maybeConnectRunner();
  const serverManager = createServerManager(
    runnerClient
      ? { storage, adapter, secrets, runnerClient }
      : { storage, adapter, secrets },
  );

  // Seed the built-in demo server into the durable catalog (idempotent by id).
  const demoDefinition = storage.servers.upsertById({
    id: "demo",
    displayName: "Built-in demo",
    transport: "streamable-http",
    endpoint: demo.url,
    protocolPolicy: "modern",
  });

  let negotiation: ProtocolNegotiation | undefined;
  try {
    const binding = await serverManager.connect(demoDefinition);
    negotiation = binding.negotiation;
  } catch (err) {
    await demo.close();
    storage.close();
    throw err;
  }

  const app = buildGatewayApp(
    runnerClient
      ? { adapter, storage, serverManager, secrets, runnerClient }
      : { adapter, storage, serverManager, secrets },
  );
  mountWebAssets(app);
  const port = Number(process.env["PORT"] ?? 6275);
  // Default to loopback so a packaged tarball run on a host with a public
  // IP does not silently expose the API to the internet. Operators who
  // want to bind broadly opt in via MIX_HOST (e.g. "0.0.0.0").
  const hostname = process.env["MIX_HOST"] ?? "127.0.0.1";
  const server = serve({ fetch: app.fetch, port, hostname }, (info) => {
    console.log(
      `MCP Inspector X gateway listening on http://${hostname}:${info.port}`,
    );
    if (negotiation) {
      console.log(
        `  demo MCP server at ${demo.url} (era=${negotiation.negotiatedEra} version=${negotiation.selectedVersion})`,
      );
    }
  });

  const shutdown = async () => {
    console.log("shutting down…");
    server.close();
    for (const b of serverManager.bindings()) {
      await adapter.disconnect(b.descriptor.id).catch(() => {});
    }
    await runnerClient?.close().catch(() => {});
    await demo.close().catch(() => {});
    storage.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

void main().catch((err) => {
  console.error("gateway boot failed:", err);
  process.exit(1);
});
