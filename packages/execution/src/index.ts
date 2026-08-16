import type { JsonValue, ProtocolEvidence } from "@mcp-inspector-x/protocol";

export type ExecutionStatus =
  | "queued"
  | "validating"
  | "running"
  | "awaiting_input"
  | "retrying"
  | "task_created"
  | "polling"
  | "complete"
  | "error"
  | "cancelled";

export interface ExecutionTransition {
  at: string;
  from: ExecutionStatus;
  to: ExecutionStatus;
  detail?: string;
}

export interface ExecutionRecord {
  executionId: string;
  capabilityId: string;
  status: ExecutionStatus;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  result?: JsonValue;
  error?: { code: string; message: string; detail?: JsonValue };
  evidence?: ProtocolEvidence;
  transitions: ExecutionTransition[];
}

const ALLOWED: Record<ExecutionStatus, readonly ExecutionStatus[]> = {
  queued: ["validating", "cancelled"],
  validating: ["running", "error", "cancelled"],
  running: ["awaiting_input", "task_created", "complete", "error", "cancelled"],
  awaiting_input: ["retrying", "cancelled", "error"],
  retrying: ["awaiting_input", "task_created", "complete", "error", "cancelled"],
  task_created: ["polling", "cancelled", "error"],
  polling: ["polling", "awaiting_input", "complete", "error", "cancelled"],
  complete: [],
  error: [],
  cancelled: [],
};

export function canTransition(from: ExecutionStatus, to: ExecutionStatus): boolean {
  return ALLOWED[from].includes(to);
}

export function transitionExecution(record: ExecutionRecord, to: ExecutionStatus, detail?: string): ExecutionRecord {
  if (!canTransition(record.status, to)) {
    throw new Error(`Illegal execution transition: ${record.status} -> ${to}`);
  }
  const at = new Date().toISOString();
  return {
    ...record,
    status: to,
    transitions: [...record.transitions, { at, from: record.status, to, ...(detail ? { detail } : {}) }],
  };
}

export function createExecutionRecord(input: Omit<ExecutionRecord, "transitions">): ExecutionRecord {
  return { ...input, transitions: [] };
}

export async function runConcurrent<T, R>(
  items: readonly T[],
  worker: (item: T, index: number) => Promise<R>,
  concurrency = 4,
): Promise<Array<{ ok: true; value: R } | { ok: false; error: unknown }>> {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("concurrency must be >= 1");
  const results = new Array<{ ok: true; value: R } | { ok: false; error: unknown }>(items.length);
  let cursor = 0;

  async function consume() {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      try {
        results[index] = { ok: true, value: await worker(items[index] as T, index) };
      } catch (error) {
        results[index] = { ok: false, error };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => consume()));
  return results;
}
