import { useEffect, useState } from "react";
import {
  cancelExecutionApi,
  compareExecutionsApi,
  getExecution,
  listExecutions,
  retryExecutionApi,
} from "../api/client";
import type { CompareResult, ExecutionDetail, ExecutionRecord, JsonValue } from "../api/types";
import { RendererView } from "../renderer-view";

export function ExecutionsPage() {
  const [executions, setExecutions] = useState<ExecutionRecord[]>([]);
  const [capabilityFilter, setCapabilityFilter] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [compareIds, setCompareIds] = useState<[string | null, string | null]>([null, null]);
  const [compareResult, setCompareResult] = useState<CompareResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  function refresh() {
    listExecutions(capabilityFilter ? { capabilityId: capabilityFilter } : undefined)
      .then((res) => setExecutions(res.executions))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }
  useEffect(refresh, [capabilityFilter]);

  function toggleCompare(id: string) {
    setCompareIds(([a, b]) => {
      if (a === id) return [null, b];
      if (b === id) return [a, null];
      if (a === null) return [id, b];
      if (b === null) return [a, id];
      return [id, b];
    });
  }

  async function runCompare() {
    const [left, right] = compareIds;
    if (!left || !right) return;
    try {
      setCompareResult(await compareExecutionsApi(left, right));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="page" data-testid="executions-page">
      <h2>Execution history</h2>
      {error && <p className="form-error">{error}</p>}
      <div className="field-row">
        <input
          placeholder="filter by capabilityId"
          value={capabilityFilter}
          onChange={(e) => setCapabilityFilter(e.target.value)}
        />
        <button className="button" onClick={runCompare} disabled={!compareIds[0] || !compareIds[1]}>
          Compare selected
        </button>
      </div>

      <table className="data-table">
        <thead>
          <tr>
            <th>Compare</th>
            <th>Capability</th>
            <th>Status</th>
            <th>Started</th>
          </tr>
        </thead>
        <tbody>
          {executions.map((ex) => (
            <tr key={ex.id} className={ex.id === selectedId ? "selected" : ""}>
              <td onClick={(e) => e.stopPropagation()}>
                <input
                  type="checkbox"
                  checked={compareIds.includes(ex.id)}
                  onChange={() => toggleCompare(ex.id)}
                />
              </td>
              <td onClick={() => setSelectedId(ex.id)}>{ex.capabilityId}</td>
              <td onClick={() => setSelectedId(ex.id)}>
                <span className={`status ${ex.status}`}>{ex.status}</span>
              </td>
              <td onClick={() => setSelectedId(ex.id)}>{ex.startedAt}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {compareResult && (
        <div className="panel">
          <h3>Comparison</h3>
          <pre>{JSON.stringify(compareResult, null, 2)}</pre>
        </div>
      )}

      {selectedId && <ExecutionDetailView id={selectedId} onChanged={refresh} />}
    </div>
  );
}

function ExecutionDetailView({ id, onChanged }: { id: string; onChanged: () => void }) {
  const [detail, setDetail] = useState<ExecutionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  function refresh() {
    getExecution(id)
      .then(setDetail)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }
  useEffect(refresh, [id]);

  const lastRound = detail?.rounds[detail.rounds.length - 1];
  const canCancel = detail?.execution.status === "running" || detail?.execution.status === "task_working";

  return (
    <div className="panel" data-testid="execution-detail">
      <div className="workspace-toolbar">
        <h3>Execution {id}</h3>
        <div className="topbar-spacer" />
        <button
          className="button"
          disabled={!canCancel}
          onClick={() => cancelExecutionApi(id).then(() => { refresh(); onChanged(); })}
        >
          Cancel
        </button>
        <button
          className="button"
          onClick={() => retryExecutionApi(id).then(() => onChanged())}
        >
          Retry
        </button>
      </div>
      {error && <p className="form-error">{error}</p>}
      {detail && (
        <>
          <p className="muted">
            status: <span className={`status ${detail.execution.status}`}>{detail.execution.status}</span> · rounds:{" "}
            {detail.rounds.length} · evidence: {detail.evidence.length}
          </p>
          {lastRound && (
            <RendererView
              value={lastRound.resultInlineJson ? (JSON.parse(lastRound.resultInlineJson) as JsonValue) : undefined}
              resultArtifact={lastRound.resultArtifact}
            />
          )}
        </>
      )}
    </div>
  );
}
