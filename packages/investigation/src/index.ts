import type { ExecutionRecord } from "@mcp-inspector-x/execution";
import type { JsonObject, JsonValue, ProtocolEvidence } from "@mcp-inspector-x/protocol";

export interface RedactionRecord {
  path: string;
  reason: string;
}

export interface InvestigationPacket {
  packetId: string;
  generatedAt: string;
  executions: ExecutionRecord[];
  context?: JsonValue;
  redactions: RedactionRecord[];
}

const SENSITIVE_KEY = /(authorization|api[-_]?key|token|secret|password|cookie|credential)/i;

export function redactJson(value: JsonValue, path = "$", redactions: RedactionRecord[] = []): { value: JsonValue; redactions: RedactionRecord[] } {
  if (Array.isArray(value)) {
    return {
      value: value.map((item, index) => redactJson(item, `${path}[${index}]`, redactions).value),
      redactions,
    };
  }
  if (value !== null && typeof value === "object") {
    const output: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      const itemPath = `${path}.${key}`;
      if (SENSITIVE_KEY.test(key)) {
        output[key] = "[REDACTED]";
        redactions.push({ path: itemPath, reason: "sensitive-key-policy" });
      } else {
        output[key] = redactJson(item, itemPath, redactions).value;
      }
    }
    return { value: output, redactions };
  }
  return { value, redactions };
}

function redactStringMap(input: Record<string, string> | undefined, path: string, redactions: RedactionRecord[]): Record<string, string> | undefined {
  if (!input) return undefined;
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (SENSITIVE_KEY.test(key)) {
      output[key] = "[REDACTED]";
      redactions.push({ path: `${path}.${key}`, reason: "sensitive-key-policy" });
    } else {
      output[key] = value;
    }
  }
  return output;
}

function redactJsonObject(input: JsonObject | undefined, path: string, redactions: RedactionRecord[]): JsonObject | undefined {
  if (!input) return undefined;
  return redactJson(input, path, redactions).value as JsonObject;
}

function redactEvidence(evidence: ProtocolEvidence | undefined, path: string, redactions: RedactionRecord[]): ProtocolEvidence | undefined {
  if (!evidence) return undefined;
  const requestMeta = redactJsonObject(evidence.requestMeta, `${path}.requestMeta`, redactions);
  const responseMeta = redactJsonObject(evidence.responseMeta, `${path}.responseMeta`, redactions);
  const httpHeaders = redactStringMap(evidence.httpHeaders, `${path}.httpHeaders`, redactions);
  return {
    ...evidence,
    ...(requestMeta ? { requestMeta } : {}),
    ...(responseMeta ? { responseMeta } : {}),
    ...(httpHeaders ? { httpHeaders } : {}),
    ...(evidence.baggage ? { baggage: "[REDACTED]" } : {}),
  };
}

function redactExecution(execution: ExecutionRecord, index: number, redactions: RedactionRecord[]): ExecutionRecord {
  const path = `$.executions[${index}]`;
  const result = execution.result === undefined ? undefined : redactJson(execution.result, `${path}.result`, redactions).value;
  const errorDetail = execution.error?.detail === undefined ? undefined : redactJson(execution.error.detail, `${path}.error.detail`, redactions).value;
  const evidence = redactEvidence(execution.evidence, `${path}.evidence`, redactions);
  return {
    ...execution,
    ...(result === undefined ? {} : { result }),
    ...(execution.error ? {
      error: {
        ...execution.error,
        ...(errorDetail === undefined ? {} : { detail: errorDetail }),
      },
    } : {}),
    ...(evidence ? { evidence } : {}),
  };
}

export function buildInvestigationPacket(input: {
  packetId: string;
  executions: ExecutionRecord[];
  context?: JsonValue;
}): InvestigationPacket {
  const redactions: RedactionRecord[] = [];
  const context = input.context === undefined ? undefined : redactJson(input.context, "$.context", redactions).value;
  const executions = input.executions.map((execution, index) => redactExecution(execution, index, redactions));
  return {
    packetId: input.packetId,
    generatedAt: new Date().toISOString(),
    executions,
    ...(context === undefined ? {} : { context }),
    redactions,
  };
}

export function renderInvestigationMarkdown(packet: InvestigationPacket): string {
  const executions = packet.executions.map((execution) => [
    `## ${execution.capabilityId}`,
    `- Execution: \`${execution.executionId}\``,
    `- Status: **${execution.status}**`,
    execution.durationMs === undefined ? "" : `- Duration: ${execution.durationMs} ms`,
    execution.evidence?.version ? `- Protocol: ${execution.evidence.era ?? "unknown"} / ${execution.evidence.version}` : "",
    execution.error ? `\n### Error\n\`${execution.error.code}\` — ${execution.error.message}` : "",
    execution.result === undefined ? "" : `\n### Result\n\`\`\`json\n${JSON.stringify(execution.result, null, 2)}\n\`\`\``,
  ].filter(Boolean).join("\n")).join("\n\n");

  const redactions = packet.redactions.length === 0
    ? "None recorded."
    : packet.redactions.map((item) => `- ${item.path}: ${item.reason}`).join("\n");

  return `# MCP Inspector X Investigation Packet\n\nPacket: \`${packet.packetId}\`\nGenerated: ${packet.generatedAt}\n\n${executions}\n\n## Redactions\n${redactions}\n\n## Investigation request\nDetermine root cause, classify the failure, identify the relevant source/runtime evidence, propose remediation, and state the verification required. Do not assume bounded snippets represent the complete implementation.`;
}
