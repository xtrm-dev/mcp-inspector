import { useEffect, useState } from "react";
import { buildInvestigationPacket, listExecutions } from "../api/client";
import type { ExecutionRecord, PacketFormat, PacketTier } from "../api/types";

// UX-8: per-tier evidence composition. Mockup + PRD §36 name the ten
// categories users need to see BEFORE they build a packet. Availability
// is derived per-selection at render time; missing evidence is shown
// explicitly (grey + "n/a for selection"), not silently dropped.
type EvidenceCategory =
  | "arguments"
  | "raw_result"
  | "formatted_result"
  | "errors"
  | "protocol_evidence"
  | "trace"
  | "source_graph"
  | "snippets"
  | "revision"
  | "previous_good_run"
  | "diffs"
  | "redactions";

const CATEGORY_LABELS: Record<EvidenceCategory, string> = {
  arguments: "Arguments + schema",
  raw_result: "Raw result",
  formatted_result: "Formatted result",
  errors: "Errors",
  protocol_evidence: "Protocol evidence",
  trace: "Distributed trace",
  source_graph: "Source graph",
  snippets: "Relevant code snippets",
  revision: "Repository + commit SHA",
  previous_good_run: "Previous successful run",
  diffs: "Result / config diff",
  redactions: "Explicit redactions",
};

const TIER_INCLUDES: Record<PacketTier, ReadonlySet<EvidenceCategory>> = {
  compact: new Set(["arguments", "formatted_result", "errors", "redactions"]),
  investigation: new Set([
    "arguments",
    "raw_result",
    "formatted_result",
    "errors",
    "protocol_evidence",
    "trace",
    "source_graph",
    "snippets",
    "revision",
    "previous_good_run",
    "redactions",
  ]),
  exhaustive: new Set([
    "arguments",
    "raw_result",
    "formatted_result",
    "errors",
    "protocol_evidence",
    "trace",
    "source_graph",
    "snippets",
    "revision",
    "previous_good_run",
    "diffs",
    "redactions",
  ]),
};

function availableFor(
  category: EvidenceCategory,
  executions: ExecutionRecord[],
): "yes" | "partial" | "no" {
  if (executions.length === 0) return "no";
  const anyErrored = executions.some((e) => e.status === "failed" || e.status === "cancelled");
  const anyComplete = executions.some((e) => e.status === "complete");
  switch (category) {
    case "arguments":
    case "raw_result":
    case "formatted_result":
    case "protocol_evidence":
    case "revision":
      return "yes";
    case "errors":
      return anyErrored ? "yes" : "no";
    case "trace":
      // Trace correlation is best-effort; report as partial rather than
      // promising presence.
      return "partial";
    case "source_graph":
    case "snippets":
      return "partial";
    case "previous_good_run":
    case "diffs":
      return anyErrored && anyComplete ? "yes" : anyErrored ? "partial" : "no";
    case "redactions":
      return "yes";
  }
}

export function PacketsPage() {
  const [executions, setExecutions] = useState<ExecutionRecord[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [tier, setTier] = useState<PacketTier>("investigation");
  const [format, setFormat] = useState<PacketFormat>("markdown");
  const [output, setOutput] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [building, setBuilding] = useState(false);

  useEffect(() => {
    listExecutions({ limit: 50 }).then((res) => setExecutions(res.executions));
  }, []);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function build() {
    if (selected.size === 0) return;
    setBuilding(true);
    setError(null);
    try {
      const result = await buildInvestigationPacket({
        executionIds: Array.from(selected),
        tier,
        format,
      });
      setOutput(typeof result === "string" ? result : JSON.stringify(result.packet, null, 2));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBuilding(false);
    }
  }

  return (
    <div className="page" data-testid="packets-page">
      <h2>Investigation packet export</h2>
      {error && <p className="form-error">{error}</p>}

      <div className="field-row">
        <label>
          Tier
          <select value={tier} onChange={(e) => setTier(e.target.value as PacketTier)}>
            <option value="compact">compact</option>
            <option value="investigation">investigation</option>
            <option value="exhaustive">exhaustive</option>
          </select>
        </label>
        <label>
          Format
          <select value={format} onChange={(e) => setFormat(e.target.value as PacketFormat)}>
            <option value="markdown">markdown</option>
            <option value="json">json</option>
          </select>
        </label>
        <button className="button primary" onClick={build} disabled={selected.size === 0 || building}>
          {building ? "Building…" : `Build packet (${selected.size} executions)`}
        </button>
      </div>

      <ul className="entity-list">
        {executions.map((ex) => (
          <li key={ex.id}>
            <label className="checkbox-label">
              <input type="checkbox" checked={selected.has(ex.id)} onChange={() => toggle(ex.id)} />
              {ex.capabilityId} · <span className={`status ${ex.status}`}>{ex.status}</span>
            </label>
          </li>
        ))}
      </ul>

      {selected.size > 0 && (
        <div className="panel packet-preview" data-testid="packet-will-include">
          <h3>Will include ({tier})</h3>
          <p className="muted">
            Preview of the evidence categories the {tier} tier composes across your {selected.size}{" "}
            selected execution{selected.size === 1 ? "" : "s"}. Missing evidence is shown as{" "}
            <em>n/a for selection</em> rather than silently dropped.
          </p>
          <ul className="packet-category-list">
            {(Object.keys(CATEGORY_LABELS) as EvidenceCategory[]).map((cat) => {
              const included = TIER_INCLUDES[tier].has(cat);
              const selectedExecs = executions.filter((e) => selected.has(e.id));
              const avail = availableFor(cat, selectedExecs);
              const cls = !included
                ? "packet-cat-excluded"
                : avail === "yes"
                  ? "packet-cat-included"
                  : avail === "partial"
                    ? "packet-cat-partial"
                    : "packet-cat-missing";
              const label = !included
                ? "excluded by tier"
                : avail === "yes"
                  ? "included"
                  : avail === "partial"
                    ? "included (partial)"
                    : "n/a for selection";
              return (
                <li key={cat} className={cls} data-testid={`packet-cat-${cat}`}>
                  <span className="packet-cat-name">{CATEGORY_LABELS[cat]}</span>
                  <span className="packet-cat-status muted">{label}</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {output && (
        <div className="panel">
          <div className="workspace-toolbar">
            <h3>Packet output</h3>
            <div className="topbar-spacer" />
            <button className="button" onClick={() => navigator.clipboard?.writeText(output)}>
              Copy
            </button>
          </div>
          <pre data-testid="packet-output">{output}</pre>
        </div>
      )}
    </div>
  );
}
