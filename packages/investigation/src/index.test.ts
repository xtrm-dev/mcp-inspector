import { describe, expect, it } from "vitest";
import { createExecutionRecord } from "@mcp-inspector-x/execution";
import { buildInvestigationPacket, renderInvestigationMarkdown } from "./index";

describe("investigation packet", () => {
  it("redacts result fields and protocol headers while recording every redaction", () => {
    const execution = createExecutionRecord({
      executionId: "exec-1",
      capabilityId: "server/tool/test",
      status: "error",
      startedAt: "2026-08-16T00:00:00.000Z",
      result: { apiKey: "secret-value", nested: { value: 42 } },
      evidence: {
        era: "modern",
        version: "2026-07-28",
        httpHeaders: { Authorization: "Bearer secret", "Mcp-Method": "tools/call" },
      },
    });

    const packet = buildInvestigationPacket({ packetId: "packet-1", executions: [execution] });
    expect(packet.executions[0]?.result).toEqual({ apiKey: "[REDACTED]", nested: { value: 42 } });
    expect(packet.executions[0]?.evidence?.httpHeaders?.Authorization).toBe("[REDACTED]");
    expect(packet.redactions).toHaveLength(2);
    expect(renderInvestigationMarkdown(packet)).toContain("## Redactions");
  });
});
