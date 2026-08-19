import type { JsonValue } from "@mcp-inspector-x/protocol";
import { redactJson, type RedactionRecord } from "@mcp-inspector-x/investigation";
import type {
  Storage,
  ExecutionRecord,
  ExecutionRound,
  EvidenceRef,
} from "@mcp-inspector-x/storage";
import { snapshotExecution } from "./compare";

export type PacketTier = "compact" | "investigation" | "exhaustive";
export type PacketFormat = "json" | "markdown";

export interface PacketExecutionSummary {
  executionId: string;
  capabilityId: string;
  status: string;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  argumentsJson: JsonValue | null;
  resultInline: JsonValue | null;
  resultArtifact: string | null;
  errorJson: JsonValue | null;
  rounds?: PacketRound[];
  evidence?: PacketEvidence[];
}

export interface PacketRound {
  roundIndex: number;
  kind: string;
  argumentsJson: JsonValue | null;
  resultInline: JsonValue | null;
  resultArtifact: string | null;
  errorJson: JsonValue | null;
  durationMs: number | null;
  startedAt: string;
  endedAt: string | null;
}

export interface PacketEvidence {
  id: string;
  kind: string;
  artifactRef: string;
  recordedAt: string;
}

export interface PacketMissingEvidence {
  executionId: string;
  what: string;
  reason: string;
}

export interface InvestigationPacketV2 {
  packetId: string;
  generatedAt: string;
  tier: PacketTier;
  executions: PacketExecutionSummary[];
  redactions: RedactionRecord[];
  missing: PacketMissingEvidence[];
}

export interface BuildPacketInput {
  storage: Storage;
  executionIds: string[];
  tier?: PacketTier;
  packetId?: string;
  now?: () => Date;
}

export function buildPacket(input: BuildPacketInput): InvestigationPacketV2 | { error: string } {
  const tier: PacketTier = input.tier ?? "investigation";
  const packetId = input.packetId ?? cryptoRandomId();
  const generatedAt = (input.now ?? (() => new Date()))().toISOString();
  const redactions: RedactionRecord[] = [];
  const missing: PacketMissingEvidence[] = [];

  const executions: PacketExecutionSummary[] = [];
  for (const id of input.executionIds) {
    const snap = snapshotExecution(input.storage, id);
    if (!snap) return { error: `unknown execution '${id}'` };
    executions.push(assemble(snap, tier, input.storage, redactions, missing));
  }

  return { packetId, generatedAt, tier, executions, redactions, missing };
}

function assemble(
  snap: { execution: ExecutionRecord; rounds: ExecutionRound[]; evidence: EvidenceRef[] },
  tier: PacketTier,
  storage: Storage,
  redactions: RedactionRecord[],
  missing: PacketMissingEvidence[],
): PacketExecutionSummary {
  const { execution, rounds, evidence } = snap;
  const durationMs =
    execution.endedAt !== null
      ? new Date(execution.endedAt).getTime() - new Date(execution.startedAt).getTime()
      : null;

  const first = rounds[0] ?? null;
  const summary: PacketExecutionSummary = {
    executionId: execution.id,
    capabilityId: execution.capabilityId,
    status: execution.status,
    startedAt: execution.startedAt,
    endedAt: execution.endedAt,
    durationMs,
    argumentsJson: redactField(safeParseJson(first?.argumentsJson ?? null), `$.${execution.id}.arguments`, redactions),
    resultInline:
      tier === "compact"
        ? null
        : redactField(safeParseJson(first?.resultInlineJson ?? null), `$.${execution.id}.result`, redactions),
    resultArtifact: tier === "compact" ? null : first?.resultArtifact ?? null,
    errorJson: redactField(safeParseJson(first?.errorJson ?? null), `$.${execution.id}.error`, redactions),
  };

  if (tier === "exhaustive") {
    summary.rounds = rounds.map((r) => ({
      roundIndex: r.roundIndex,
      kind: r.kind,
      argumentsJson: redactField(safeParseJson(r.argumentsJson), `$.${execution.id}.rounds[${r.roundIndex}].arguments`, redactions),
      resultInline: redactField(safeParseJson(r.resultInlineJson), `$.${execution.id}.rounds[${r.roundIndex}].result`, redactions),
      resultArtifact: r.resultArtifact,
      errorJson: redactField(safeParseJson(r.errorJson), `$.${execution.id}.rounds[${r.roundIndex}].error`, redactions),
      durationMs: r.durationMs,
      startedAt: r.startedAt,
      endedAt: r.endedAt,
    }));
    summary.evidence = evidence.map((e) => ({
      id: e.id,
      kind: e.kind,
      artifactRef: e.artifactRef,
      recordedAt: e.recordedAt,
    }));
  } else if (tier === "investigation") {
    summary.evidence = evidence.slice(0, 1).map((e) => ({
      id: e.id,
      kind: e.kind,
      artifactRef: e.artifactRef,
      recordedAt: e.recordedAt,
    }));
  }

  // Explicit "missing" reporting for evidence tiers ADR-0003 expects the packet to name
  // (source revision, trace context). We don't have those substrates wired yet — mark
  // them missing rather than silently absent.
  missing.push({ executionId: execution.id, what: "source-revision", reason: "Phase M not yet landed" });
  missing.push({ executionId: execution.id, what: "trace-context", reason: "Phase M not yet landed" });
  void storage;
  return summary;
}

function safeParseJson(input: string | null): JsonValue | null {
  if (input === null) return null;
  try {
    return JSON.parse(input) as JsonValue;
  } catch {
    return input;
  }
}

function redactField(
  value: JsonValue | null,
  path: string,
  redactions: RedactionRecord[],
): JsonValue | null {
  if (value === null) return null;
  return redactJson(value, path, redactions).value;
}

function cryptoRandomId(): string {
  // Not cryptographic — a compact opaque id is fine here.
  return `packet-${Math.random().toString(36).slice(2, 10)}${Math.random().toString(36).slice(2, 10)}`;
}

// ---- Markdown rendering ----

export function renderPacketMarkdown(packet: InvestigationPacketV2): string {
  const header =
    `# MCP Inspector X Investigation Packet\n\n` +
    `- Packet: \`${packet.packetId}\`\n` +
    `- Tier: **${packet.tier}**\n` +
    `- Generated: ${packet.generatedAt}\n`;

  const executions = packet.executions
    .map((e) => renderExecutionMarkdown(e))
    .join("\n\n");

  const redactions =
    packet.redactions.length === 0
      ? "None recorded."
      : packet.redactions.map((r) => `- \`${r.path}\` — ${r.reason}`).join("\n");

  const missing =
    packet.missing.length === 0
      ? "None reported."
      : packet.missing.map((m) => `- ${m.executionId} — **${m.what}**: ${m.reason}`).join("\n");

  return `${header}\n${executions}\n\n## Redactions\n\n${redactions}\n\n## Missing evidence\n\n${missing}\n\n## Investigation request\n\nDetermine root cause, classify the failure, identify the relevant source/runtime evidence when present, propose remediation, and state the verification required. Bounded snippets do not represent the complete implementation.\n`;
}

function renderExecutionMarkdown(e: PacketExecutionSummary): string {
  const lines: string[] = [
    `## ${e.capabilityId}`,
    `- Execution: \`${e.executionId}\``,
    `- Status: **${e.status}**`,
    e.durationMs !== null ? `- Duration: ${e.durationMs} ms` : "",
    e.argumentsJson !== null
      ? `\n### Arguments\n\`\`\`json\n${JSON.stringify(e.argumentsJson, null, 2)}\n\`\`\``
      : "",
    e.resultInline !== null
      ? `\n### Result\n\`\`\`json\n${JSON.stringify(e.resultInline, null, 2)}\n\`\`\``
      : e.resultArtifact !== null
        ? `\n### Result\nArtifact \`${e.resultArtifact}\` (not inlined — retrieve via /api/v1/artifacts).`
        : "",
    e.errorJson !== null
      ? `\n### Error\n\`\`\`json\n${JSON.stringify(e.errorJson, null, 2)}\n\`\`\``
      : "",
    e.rounds && e.rounds.length > 0
      ? `\n### Rounds (${e.rounds.length})\n${e.rounds.map((r) => `- round ${r.roundIndex} (${r.kind}) — ${r.durationMs ?? "?"} ms`).join("\n")}`
      : "",
    e.evidence && e.evidence.length > 0
      ? `\n### Evidence\n${e.evidence.map((ev) => `- ${ev.kind} → artifact \`${ev.artifactRef}\``).join("\n")}`
      : "",
  ];
  return lines.filter(Boolean).join("\n");
}
