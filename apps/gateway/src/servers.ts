import {
  type McpClientAdapter,
  type McpServerDescriptor,
  type ProtocolNegotiation,
  type ProtocolEraPolicy,
} from "@mcp-inspector-x/protocol";
import type { RunnerClient, RunnerSpawnStdioMcpParams } from "@mcp-inspector-x/runner";
import type { ServerDefinition, Storage } from "@mcp-inspector-x/storage";
import type { SecretsRegistry } from "./secrets";

export interface ServerBinding {
  descriptor: McpServerDescriptor;
  negotiation: ProtocolNegotiation;
  // Set only for transport:"stdio" bindings — the privileged runner's
  // session id, needed so disconnect() can call runner.closeStdioMcp.
  runnerSessionId?: string;
}

export interface ServerManagerOptions {
  storage: Storage;
  adapter: McpClientAdapter;
  secrets: SecretsRegistry;
  // Required for transport:"stdio" servers — the runner is the only thing
  // allowed to spawn the child MCP process (ADR-0003). Omit it and any
  // stdio connect() attempt fails fast with a clear error.
  runnerClient?: RunnerClient;
}

export interface ServerManager {
  bindings(): ServerBinding[];
  getBinding(id: string): ServerBinding | undefined;
  register(binding: ServerBinding): void;
  connect(definition: ServerDefinition): Promise<ServerBinding>;
  disconnect(id: string): Promise<void>;
  reconnectIfConnected(definition: ServerDefinition): Promise<ServerBinding | null>;
  testConnection(definition: ServerDefinition): Promise<ConnectionTestResult>;
}

export interface ConnectionTestResult {
  reachable: boolean;
  status?: number;
  message: string;
  transport: string;
  durationMs: number;
}

export function createServerManager(options: ServerManagerOptions): ServerManager {
  const { storage, adapter, secrets, runnerClient } = options;
  const bindings = new Map<string, ServerBinding>();

  function ensureDescriptor(def: ServerDefinition): McpServerDescriptor {
    if (def.transport !== "streamable-http" && def.transport !== "stdio") {
      throw new Error(
        `server '${def.id}': transport '${def.transport}' not supported by the current SDK adapter`,
      );
    }
    if (def.transport === "stdio" && !def.command) {
      throw new Error(`server '${def.id}': stdio transport requires 'command'`);
    }
    const desc: McpServerDescriptor = {
      id: def.id,
      displayName: def.displayName,
      transport: def.transport,
      protocol: { policy: def.protocolPolicy as ProtocolEraPolicy },
    };
    if (def.endpoint !== null) desc.url = def.endpoint;
    if (def.command !== null) desc.command = def.command;
    if (def.credentialRefId !== null) {
      // Resolving here surfaces a clear pre-connect error if the credential is
      // missing, instead of failing inside the SDK transport with a 401.
      desc.bearerToken = secrets.resolve(def.credentialRefId);
    }
    return desc;
  }

  async function connect(definition: ServerDefinition): Promise<ServerBinding> {
    if (bindings.has(definition.id)) {
      throw new Error(`server '${definition.id}' already connected`);
    }
    if (definition.disabled) {
      throw new Error(`server '${definition.id}' is disabled`);
    }
    const descriptor = ensureDescriptor(definition);

    // Stdio MCP is spawned by the privileged runner, never here (ADR-0003).
    // The runner hands back a UDS the SDK adapter speaks line-delimited
    // JSON-RPC over — see packages/protocol/src/sdk-adapter.ts.
    let runnerSessionId: string | undefined;
    if (definition.transport === "stdio") {
      if (!runnerClient) {
        throw new Error(
          `server '${definition.id}': stdio transport requires a privileged runner (none configured on this ServerManager)`,
        );
      }
      const spawnParams: RunnerSpawnStdioMcpParams = { command: definition.command! };
      if (definition.args) spawnParams.args = definition.args;
      if (definition.cwd) spawnParams.cwd = definition.cwd;
      if (definition.env) spawnParams.env = definition.env;
      const spawned = await runnerClient.spawnStdioMcp(spawnParams);
      runnerSessionId = spawned.sessionId;
      descriptor.socketPath = spawned.socketPath;
    }

    let negotiation: ProtocolNegotiation;
    try {
      negotiation = await adapter.connect(descriptor);
    } catch (err) {
      if (runnerSessionId !== undefined && runnerClient) {
        await runnerClient.closeStdioMcp({ sessionId: runnerSessionId }).catch(() => {});
      }
      throw err;
    }

    const binding: ServerBinding = { descriptor, negotiation };
    if (runnerSessionId !== undefined) binding.runnerSessionId = runnerSessionId;
    bindings.set(definition.id, binding);
    storage.events.append({
      kind: "server.connected",
      payload: {
        serverId: definition.id,
        transport: definition.transport,
        negotiatedEra: negotiation.negotiatedEra,
        selectedVersion: negotiation.selectedVersion,
      },
    });
    return binding;
  }

  async function disconnect(id: string): Promise<void> {
    const binding = bindings.get(id);
    if (!binding) return;
    bindings.delete(id);
    await adapter.disconnect(id).catch(() => {});
    if (binding.runnerSessionId !== undefined && runnerClient) {
      await runnerClient.closeStdioMcp({ sessionId: binding.runnerSessionId }).catch(() => {});
    }
    storage.events.append({ kind: "server.disconnected", payload: { serverId: id } });
  }

  async function reconnectIfConnected(definition: ServerDefinition): Promise<ServerBinding | null> {
    if (!bindings.has(definition.id)) return null;
    await disconnect(definition.id);
    return connect(definition);
  }

  async function testConnection(definition: ServerDefinition): Promise<ConnectionTestResult> {
    const startedAt = Date.now();
    if (definition.transport === "streamable-http" || definition.transport === "sse") {
      if (!definition.endpoint) {
        return {
          reachable: false,
          message: "endpoint URL required",
          transport: definition.transport,
          durationMs: 0,
        };
      }
      try {
        // Two-attempt probe: HEAD, then GET. Some MCP endpoints reject
        // HEAD but respond to GET/EventStream — treat 405/406/415 as
        // "reachable but wrong verb", not "unreachable".
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
        let response: Response;
        try {
          response = await fetch(definition.endpoint, {
            method: "HEAD",
            signal: controller.signal,
          });
          if (response.status === 405 || response.status === 406 || response.status === 415) {
            response = await fetch(definition.endpoint, {
              method: "GET",
              signal: controller.signal,
              headers: { accept: "text/event-stream, application/json" },
            });
          }
        } finally {
          clearTimeout(timer);
        }
        const durationMs = Date.now() - startedAt;
        const reachable = response.status < 500;
        return {
          reachable,
          status: response.status,
          message: reachable ? `HTTP ${response.status}` : `unreachable: HTTP ${response.status}`,
          transport: definition.transport,
          durationMs,
        };
      } catch (err) {
        return {
          reachable: false,
          message: err instanceof Error ? err.message : String(err),
          transport: definition.transport,
          durationMs: Date.now() - startedAt,
        };
      }
    }
    // ponytail: connect()/disconnect() prove the stdio path end-to-end; a
    // side-channel probe that spawns+tears down without leaving a binding
    // is a separate concern from this slice. Report explicitly rather than
    // silently reporting "reachable".
    return {
      reachable: false,
      message: "stdio test-connection not implemented (use connect/disconnect to probe)",
      transport: definition.transport,
      durationMs: 0,
    };
  }

  return {
    bindings: () => Array.from(bindings.values()),
    getBinding: (id) => bindings.get(id),
    register(binding) {
      bindings.set(binding.descriptor.id, binding);
    },
    connect,
    disconnect,
    reconnectIfConnected,
    testConnection,
  };
}
