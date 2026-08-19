import type { Storage, ExecutionRecord, ExecutionRound, EvidenceRef } from "@mcp-inspector-x/storage";

export interface ExecutionSnapshot {
  execution: ExecutionRecord;
  rounds: ExecutionRound[];
  evidence: EvidenceRef[];
}

export interface CompareResult {
  left: ExecutionSnapshot;
  right: ExecutionSnapshot;
  diff: ExecutionDiff;
}

export interface ExecutionDiff {
  capabilityId: { left: string; right: string; equal: boolean };
  status: { left: string; right: string; equal: boolean };
  durationMs: { left: number | null; right: number | null; delta: number | null };
  roundsCount: { left: number; right: number; delta: number };
  evidenceCount: { left: number; right: number; delta: number };
  firstRoundArguments: JsonDiff;
  firstRoundResult: JsonDiff;
  firstRoundError: JsonDiff;
}

export interface JsonDiff {
  equal: boolean;
  reason?: string;
  changes: JsonChange[];
}

export interface JsonChange {
  path: string;
  kind: "added" | "removed" | "changed" | "type-changed";
  left?: unknown;
  right?: unknown;
}

export function snapshotExecution(
  storage: Storage,
  id: string,
): ExecutionSnapshot | null {
  const execution = storage.executions.get(id);
  if (!execution) return null;
  const rounds = storage.rounds.listForExecution(id);
  const evidence = storage.evidence.listForExecution(id);
  return { execution, rounds, evidence };
}

export function compareExecutions(
  storage: Storage,
  leftId: string,
  rightId: string,
): CompareResult | { error: string } {
  const left = snapshotExecution(storage, leftId);
  const right = snapshotExecution(storage, rightId);
  if (!left) return { error: `unknown execution '${leftId}'` };
  if (!right) return { error: `unknown execution '${rightId}'` };

  const lRound = left.rounds[0] ?? null;
  const rRound = right.rounds[0] ?? null;
  const lDuration = left.execution.endedAt
    ? new Date(left.execution.endedAt).getTime() - new Date(left.execution.startedAt).getTime()
    : (lRound?.durationMs ?? null);
  const rDuration = right.execution.endedAt
    ? new Date(right.execution.endedAt).getTime() - new Date(right.execution.startedAt).getTime()
    : (rRound?.durationMs ?? null);

  const diff: ExecutionDiff = {
    capabilityId: {
      left: left.execution.capabilityId,
      right: right.execution.capabilityId,
      equal: left.execution.capabilityId === right.execution.capabilityId,
    },
    status: {
      left: left.execution.status,
      right: right.execution.status,
      equal: left.execution.status === right.execution.status,
    },
    durationMs: {
      left: lDuration,
      right: rDuration,
      delta: lDuration !== null && rDuration !== null ? rDuration - lDuration : null,
    },
    roundsCount: {
      left: left.rounds.length,
      right: right.rounds.length,
      delta: right.rounds.length - left.rounds.length,
    },
    evidenceCount: {
      left: left.evidence.length,
      right: right.evidence.length,
      delta: right.evidence.length - left.evidence.length,
    },
    firstRoundArguments: diffJsonStrings(lRound?.argumentsJson, rRound?.argumentsJson),
    firstRoundResult: diffFirstRoundResult(storage, lRound, rRound),
    firstRoundError: diffJsonStrings(lRound?.errorJson, rRound?.errorJson),
  };

  return { left, right, diff };
}

function diffFirstRoundResult(
  storage: Storage,
  lRound: ExecutionRound | null,
  rRound: ExecutionRound | null,
): JsonDiff {
  const lJson = materializeRoundResult(storage, lRound);
  const rJson = materializeRoundResult(storage, rRound);
  return diffJsonStrings(lJson, rJson);
}

function materializeRoundResult(storage: Storage, round: ExecutionRound | null): string | null {
  if (!round) return null;
  if (round.resultInlineJson !== null) return round.resultInlineJson;
  if (round.resultArtifact !== null) {
    try {
      return new TextDecoder().decode(storage.artifacts.getBytes(round.resultArtifact));
    } catch {
      return null;
    }
  }
  return null;
}

export function diffJsonStrings(left: string | null | undefined, right: string | null | undefined): JsonDiff {
  const changes: JsonChange[] = [];
  const lParsed = safeParse(left);
  const rParsed = safeParse(right);
  if (lParsed === UNPARSEABLE || rParsed === UNPARSEABLE) {
    const eq = left === right;
    const out: JsonDiff = { equal: eq, changes: [] };
    if (!eq) out.reason = "unparseable json — string equality used";
    return out;
  }
  walk("$", lParsed, rParsed, changes);
  return { equal: changes.length === 0, changes };
}

const UNPARSEABLE = Symbol("unparseable");

function safeParse(input: string | null | undefined): unknown | typeof UNPARSEABLE {
  if (input === null || input === undefined) return null;
  try {
    return JSON.parse(input);
  } catch {
    return UNPARSEABLE;
  }
}

function walk(path: string, left: unknown, right: unknown, changes: JsonChange[]): void {
  if (left === undefined && right === undefined) return;
  if (left === undefined) {
    changes.push({ path, kind: "added", right });
    return;
  }
  if (right === undefined) {
    changes.push({ path, kind: "removed", left });
    return;
  }
  if (left === null || right === null) {
    if (left === right) return;
    changes.push({ path, kind: "changed", left, right });
    return;
  }
  const lt = typeOf(left);
  const rt = typeOf(right);
  if (lt !== rt) {
    changes.push({ path, kind: "type-changed", left, right });
    return;
  }
  if (lt === "array") {
    const la = left as unknown[];
    const ra = right as unknown[];
    const n = Math.max(la.length, ra.length);
    for (let i = 0; i < n; i++) {
      walk(`${path}[${i}]`, la[i], ra[i], changes);
    }
    return;
  }
  if (lt === "object") {
    const lo = left as Record<string, unknown>;
    const ro = right as Record<string, unknown>;
    const keys = new Set([...Object.keys(lo), ...Object.keys(ro)]);
    for (const k of keys) {
      walk(`${path}.${k}`, lo[k], ro[k], changes);
    }
    return;
  }
  if (left !== right) {
    changes.push({ path, kind: "changed", left, right });
  }
}

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v; // "object" | "string" | "number" | "boolean" | ...
}
