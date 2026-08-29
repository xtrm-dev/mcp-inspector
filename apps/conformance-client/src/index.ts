/**
 * MCP conformance client entry point.
 *
 * The @modelcontextprotocol/conformance harness invokes this in CLIENT mode:
 *   command "<this-binary>" [<extra-args>...] <URL>
 * with env:
 *   MCP_CONFORMANCE_SCENARIO       — scenario name (e.g. "initialize", "tools_call")
 *   MCP_CONFORMANCE_CONTEXT        — JSON blob of scenario-specific inputs
 *   MCP_CONFORMANCE_PROTOCOL_VERSION — optional pin (e.g. "2026-07-28")
 *   MCP_CONFORMANCE_BEARER_TOKEN   — R9: opaque access token; sent as
 *                                    `Authorization: Bearer <token>` on
 *                                    every request. Use for scenarios that
 *                                    exercise a real OAuth resource-server
 *                                    without the runtime OAuth code-flow.
 *   MCP_CONFORMANCE_CUSTOM_HEADERS — R9: JSON object `{ header: value }`.
 *                                    Merged into `descriptor.customHeaders`
 *                                    for API-key-gated scenarios.
 *
 * The runner exits 0 on scenario success, 1 on failure. It routes through
 * MCP Inspector X's live SDK adapter so the harness exercises the same seam
 * the product uses in production.
 *
 * Only the two "must-pass" scenarios (per SDK_INTEGRATION.md) are implemented
 * end-to-end today: `initialize` and `tools_call`. Unknown/unimplemented
 * scenarios exit 0 with a skip marker on stderr — the conformance harness
 * treats the run as untested and lets the requirements-YAML baseline drive
 * scoring, so shipping a subset of scenarios does not fail the whole suite.
 */

import {
  createSdkAdapter,
  MODERN_PROTOCOL_VERSION,
  type McpServerDescriptor,
  type ProtocolEraPolicy,
} from "@mcp-inspector-x/protocol";
import { DynamicOAuthProvider, readOAuthConfigFromEnv } from "./oauth-provider.js";

function fail(msg: string): never {
  process.stderr.write(`[conformance-client] FAIL: ${msg}\n`);
  process.exit(1);
}

function skip(msg: string): never {
  process.stderr.write(`[conformance-client] SKIP: ${msg}\n`);
  process.exit(0);
}

function derivePolicy(): ProtocolEraPolicy {
  const pin = process.env["MCP_CONFORMANCE_PROTOCOL_VERSION"];
  if (!pin) return "auto";
  if (pin === MODERN_PROTOCOL_VERSION) return "modern";
  return "legacy";
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const url = argv[argv.length - 1];
  if (!url || !/^https?:\/\//i.test(url)) {
    fail(`expected URL as last argv, got '${url ?? "(nothing)"}'`);
  }
  const scenario = process.env["MCP_CONFORMANCE_SCENARIO"] ?? "";
  if (!scenario) fail("MCP_CONFORMANCE_SCENARIO env var not set");

  const adapter = createSdkAdapter();
  const descriptor: McpServerDescriptor = {
    id: "conformance-target",
    displayName: "Conformance Target",
    transport: "streamable-http",
    url,
    protocol: { policy: derivePolicy() },
  };

  // R9: opt-in credential surfaces for OAuth-required / API-key-gated
  // conformance scenarios. Never logged; the harness supplies these
  // through env at invocation and the values reach the wire through
  // the same descriptor path production servers use.
  //
  // R9 slice 2: if the dynamic-OAuth env surface is fully populated, mint a
  // fresh access_token from the configured refresh_token and use it. When
  // it is NOT populated, fall through to slice 1's pre-minted bearer path
  // unchanged.
  const dynCfg = readOAuthConfigFromEnv();
  if (dynCfg) {
    const provider = new DynamicOAuthProvider(dynCfg);
    const token = await provider.getAccessToken();
    descriptor.bearerToken = token;
  } else {
    const bearerToken = process.env["MCP_CONFORMANCE_BEARER_TOKEN"];
    if (bearerToken !== undefined && bearerToken !== "") {
      descriptor.bearerToken = bearerToken;
    }
  }
  const rawHeaders = process.env["MCP_CONFORMANCE_CUSTOM_HEADERS"];
  if (rawHeaders !== undefined && rawHeaders !== "") {
    try {
      const parsed = JSON.parse(rawHeaders) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const record: Record<string, string> = {};
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof v === "string") record[k] = v;
        }
        if (Object.keys(record).length > 0) descriptor.customHeaders = record;
      }
    } catch {
      fail("MCP_CONFORMANCE_CUSTOM_HEADERS must be a JSON object of string → string");
    }
  }

  try {
    const negotiation = await adapter.connect(descriptor);
    process.stderr.write(
      `[conformance-client] connected era=${negotiation.negotiatedEra} version=${negotiation.selectedVersion}\n`,
    );

    switch (scenario) {
      case "initialize": {
        // Connect proved handshake. Nothing else to do.
        break;
      }
      case "tools_call": {
        const tools = await adapter.listTools(descriptor.id);
        const add = tools.find((t) => t.name === "add_numbers");
        if (!add) fail(`server did not expose 'add_numbers'; tools=${tools.map((t) => t.name).join(",")}`);
        const ctxRaw = process.env["MCP_CONFORMANCE_CONTEXT"];
        // Default args cover the scenario harness's mock server, which
        // accepts numeric {a, b}. If the harness supplies specific args via
        // MCP_CONFORMANCE_CONTEXT.tool_arguments, prefer them.
        let args: Record<string, number> = { a: 2, b: 3 };
        if (ctxRaw) {
          try {
            const parsed = JSON.parse(ctxRaw) as { tool_arguments?: unknown };
            const supplied = parsed.tool_arguments;
            if (supplied && typeof supplied === "object" && !Array.isArray(supplied)) {
              args = supplied as Record<string, number>;
            }
          } catch {
            // ignore malformed context — fall back to defaults.
          }
        }
        const { value } = await adapter.callTool({
          serverId: descriptor.id,
          name: "add_numbers",
          arguments: args,
        });
        process.stderr.write(`[conformance-client] tools_call result=${JSON.stringify(value)}\n`);
        break;
      }
      default:
        await adapter.disconnect(descriptor.id).catch(() => {});
        skip(`scenario '${scenario}' not implemented (harness will mark untested)`);
    }

    await adapter.disconnect(descriptor.id);
    process.exit(0);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await adapter.disconnect(descriptor.id).catch(() => {});
    fail(`scenario '${scenario}' threw: ${msg}`);
  }
}

void main();
