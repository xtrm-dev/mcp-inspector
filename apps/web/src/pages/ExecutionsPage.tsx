import { useEffect, useMemo, useState } from "react";
import {
  cancelExecutionApi,
  compareExecutionsApi,
  getExecution,
  listExecutions,
  listServers,
  retryExecutionApi,
} from "../api/client";
import type {
  CompareResult,
  ExecutionDetail,
  ExecutionRecord,
  ServerSummary,
  WorkspaceNodeRow,
} from "../api/types";
import { CapabilityInspector } from "../components/WorkspaceProjections";
import { ComparisonView } from "../components/ComparisonView";

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

  // UX-5 slice 2: first-class "failed ↔ last successful" affordance per
  // dispatch §20. Finds the most recent complete execution of the same
  // capability as the currently selected failed execution and runs the
  // structured compare.
  async function compareWithLastGood() {
    const failed = executions.find((e) => e.id === selectedId);
    if (!failed) return;
    const isFailure = failed.status === "failed" || failed.status === "cancelled";
    if (!isFailure) {
      setError("compare-with-last-good is only meaningful on a failed or cancelled execution");
      return;
    }
    try {
      const res = await listExecutions({ capabilityId: failed.capabilityId });
      const lastGood = res.executions
        .filter((e) => e.status === "complete" && e.id !== failed.id)
        .find(() => true); // list is ordered newest-first per api contract
      if (!lastGood) {
        setError(`no prior successful execution of '${failed.capabilityId}' to compare against`);
        return;
      }
      setCompareIds([failed.id, lastGood.id]);
      setCompareResult(await compareExecutionsApi(failed.id, lastGood.id));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const selectedExec = executions.find((e) => e.id === selectedId);
  const selectedIsFailure =
    selectedExec?.status === "failed" || selectedExec?.status === "cancelled";

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
        <button
          className="button"
          onClick={compareWithLastGood}
          disabled={!selectedIsFailure}
          data-testid="compare-with-last-good"
          title={
            selectedIsFailure
              ? "Compare this failed run with the most recent successful run of the same capability"
              : "Select a failed or cancelled execution first"
          }
        >
          Compare with last successful
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

      {compareResult && <ComparisonView compare={compareResult} />}

      {selectedId && <ExecutionDetailView id={selectedId} onChanged={refresh} />}
    </div>
  );
}

function ExecutionDetailView({ id, onChanged }: { id: string; onChanged: () => void }) {
  const [detail, setDetail] = useState<ExecutionDetail | null>(null);
  const [servers, setServers] = useState<Map<string, ServerSummary>>(new Map());
  const [error, setError] = useState<string | null>(null);

  function refresh() {
    getExecution(id)
      .then(setDetail)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }
  useEffect(refresh, [id]);

  useEffect(() => {
    listServers()
      .then((r) => setServers(new Map(r.servers.map((s) => [s.id, s]))))
      .catch(() => setServers(new Map()));
  }, []);

  const node = useMemo<WorkspaceNodeRow | null>(() => {
    if (!detail) return null;
    const exec = detail.execution;
    return {
      id: exec.id,
      workspaceId: exec.workspaceId ?? "",
      serverId: exec.serverId,
      capabilityId: exec.capabilityId,
      argumentsJson: null,
      presentation: "expanded",
      position: 0,
      createdAt: exec.startedAt,
      updatedAt: exec.endedAt ?? exec.startedAt,
    };
  }, [detail]);

  const detailMap = useMemo(() => {
    const m = new Map<string, ExecutionDetail>();
    if (detail) m.set(detail.execution.id, detail);
    return m;
  }, [detail]);

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
      {detail && node && (
        <>
          <p className="muted">
            status: <span className={`status ${detail.execution.status}`}>{detail.execution.status}</span> · rounds:{" "}
            {detail.rounds.length} · evidence: {detail.evidence.length}
          </p>
          <div data-testid="execution-inspector">
            <CapabilityInspector
              node={node}
              servers={servers}
              selectedNodeId={node.id}
              selectedNodeIds={new Set()}
              executionDetails={detailMap}
              executionHistory={new Map()}
              descriptions={new Map()}
              inputSchemas={new Map()}
              runResult={null}
              onRunNode={async () => {}}
              onSelectNode={() => {}}
              onToggleSelected={() => {}}
              onPresentationChange={() => {}}
            />
          </div>
        </>
      )}
    </div>
  );
}
