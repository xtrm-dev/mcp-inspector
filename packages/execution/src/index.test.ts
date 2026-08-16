import { describe, expect, it } from "vitest";
import { createExecutionRecord, runConcurrent, transitionExecution } from "./index";

describe("execution state machine", () => {
  it("models an MRTR round as one logical execution", () => {
    let record = createExecutionRecord({
      executionId: "exec-1",
      capabilityId: "server/tool/example",
      status: "queued",
      startedAt: "2026-08-16T00:00:00.000Z",
    });

    record = transitionExecution(record, "validating");
    record = transitionExecution(record, "running");
    record = transitionExecution(record, "awaiting_input", "resultType=input_required");
    record = transitionExecution(record, "retrying");
    record = transitionExecution(record, "complete");

    expect(record.status).toBe("complete");
    expect(record.transitions.map((item) => item.to)).toEqual([
      "validating",
      "running",
      "awaiting_input",
      "retrying",
      "complete",
    ]);
  });

  it("rejects illegal terminal transitions", () => {
    const record = createExecutionRecord({
      executionId: "exec-2",
      capabilityId: "server/tool/example",
      status: "complete",
      startedAt: "2026-08-16T00:00:00.000Z",
    });
    expect(() => transitionExecution(record, "running")).toThrow(/Illegal execution transition/);
  });
});

describe("runConcurrent", () => {
  it("preserves order and isolates failures", async () => {
    const result = await runConcurrent([1, 2, 3], async (value) => {
      if (value === 2) throw new Error("boom");
      return value * 10;
    }, 2);

    expect(result[0]).toEqual({ ok: true, value: 10 });
    expect(result[1]?.ok).toBe(false);
    expect(result[2]).toEqual({ ok: true, value: 30 });
  });
});
