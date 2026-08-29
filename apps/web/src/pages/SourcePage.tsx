import { useEffect, useMemo, useState } from "react";
import {
  getSourceGraph,
  listSourceRevisions,
  registerSourceRevision,
} from "../api/client";
import type { SourceGraphResponse, SourceRevision } from "../api/types";
import { CodeViewer } from "../components/CodeViewer";
import { SourceGraph } from "../components/SourceGraph";

// UX-7 / Stream E: Implementation / Runtime / Combined mode toggle backed
// by real data. Implementation keeps the revision-admin surface (register +
// list). Runtime + Combined render the interactive source graph over the
// selected revision, and selecting a node opens the CodeViewer for that
// handler symbol with six sub-views (snippet / full symbol / full file /
// deps / dependents / runtime trace).

type SourceMode = "implementation" | "runtime" | "combined";

const MODE_LABELS: Record<SourceMode, string> = {
  implementation: "Implementation",
  runtime: "Runtime",
  combined: "Combined",
};

const MODE_DESCRIPTIONS: Record<SourceMode, string> = {
  implementation:
    "Static source graph. Registered revisions map protocol capabilities to file/symbol/line ranges.",
  runtime:
    "Runtime-observed edges from real executions against source-mapped capabilities.",
  combined:
    "Overlay of Implementation + Runtime. Static edges appear alongside runtime observations.",
};

export function SourcePage() {
  const [mode, setMode] = useState<SourceMode>("implementation");
  const [revisions, setRevisions] = useState<SourceRevision[]>([]);
  const [selectedRevisionId, setSelectedRevisionId] = useState<string | null>(null);
  const [graph, setGraph] = useState<SourceGraphResponse | null>(null);
  const [graphError, setGraphError] = useState<string | null>(null);
  const [selectedSymbolId, setSelectedSymbolId] = useState<string | null>(null);
  const [repositoryRef, setRepositoryRef] = useState("");
  const [revisionHash, setRevisionHash] = useState("");
  const [error, setError] = useState<string | null>(null);

  function refresh() {
    listSourceRevisions({ limit: 100 })
      .then((res) => {
        setRevisions(res.sourceRevisions);
        if (!selectedRevisionId && res.sourceRevisions[0]) {
          setSelectedRevisionId(res.sourceRevisions[0].id);
        }
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }
  useEffect(refresh, []);

  useEffect(() => {
    if (mode === "implementation" || !selectedRevisionId) {
      setGraph(null);
      return;
    }
    setGraphError(null);
    getSourceGraph(selectedRevisionId)
      .then((g) => setGraph(g))
      .catch((err) => setGraphError(err instanceof Error ? err.message : String(err)));
  }, [mode, selectedRevisionId]);

  const selectedSymbol = useMemo(() => {
    if (!graph || !selectedSymbolId) return null;
    return graph.nodes.find((n) => n.id === selectedSymbolId) ?? null;
  }, [graph, selectedSymbolId]);

  async function handleRegister(e: React.FormEvent) {
    e.preventDefault();
    if (!repositoryRef.trim() || revisionHash.trim().length < 7) return;
    try {
      await registerSourceRevision({
        repositoryRef: repositoryRef.trim(),
        revisionHash: revisionHash.trim(),
      });
      setRepositoryRef("");
      setRevisionHash("");
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="page" data-testid="source-page">
      <div className="page-header">
        <h2>Source / Runtime</h2>
        <div className="projection-picker" role="tablist" aria-label="Source projection">
          {(Object.keys(MODE_LABELS) as SourceMode[]).map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={mode === m}
              className={`chip ${mode === m ? "chip-active" : ""}`}
              data-testid={`source-mode-${m}`}
              onClick={() => setMode(m)}
            >
              {MODE_LABELS[m]}
            </button>
          ))}
        </div>
      </div>
      <p className="muted" data-testid="source-mode-description">
        {MODE_DESCRIPTIONS[mode]}
      </p>
      {error && <p className="form-error">{error}</p>}

      {mode !== "implementation" && (
        <div className="panel" data-testid={`source-${mode}-view`}>
          <div className="field-row">
            <label>
              Revision
              <select
                data-testid="source-revision-picker"
                value={selectedRevisionId ?? ""}
                onChange={(e) => {
                  setSelectedRevisionId(e.target.value || null);
                  setSelectedSymbolId(null);
                }}
              >
                <option value="">— pick a revision —</option>
                {revisions.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.repositoryRef} @ {r.shortSha ?? r.revisionHash.slice(0, 7)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {graphError && <p className="form-error">{graphError}</p>}
          {!selectedRevisionId && (
            <p className="muted">Pick a registered revision to load its source graph.</p>
          )}
          {selectedRevisionId && !graph && !graphError && (
            <p className="muted">Loading source graph…</p>
          )}
          {graph && (
            <SourceGraph
              data={graph}
              overlay={mode}
              selectedSymbolId={selectedSymbolId}
              onSelectSymbol={setSelectedSymbolId}
            />
          )}
          {graph && selectedSymbol && selectedRevisionId && (
            <CodeViewer
              revisionId={selectedRevisionId}
              filePath={selectedSymbol.filePath}
              handlerSymbol={selectedSymbol.handlerSymbol}
              onNavigate={(filePath, handlerSymbol) => {
                const next = graph.nodes.find(
                  (n) => n.filePath === filePath && n.handlerSymbol === handlerSymbol,
                );
                if (next) setSelectedSymbolId(next.id);
              }}
            />
          )}
        </div>
      )}

      {mode === "implementation" && (
        <>
          <form className="panel field-row" onSubmit={handleRegister}>
            <label>
              Repository ref
              <input value={repositoryRef} onChange={(e) => setRepositoryRef(e.target.value)} />
            </label>
            <label>
              Revision hash
              <input
                value={revisionHash}
                onChange={(e) => setRevisionHash(e.target.value)}
                minLength={7}
              />
            </label>
            <button className="button primary" type="submit">
              Register revision
            </button>
          </form>

          <table className="data-table">
            <thead>
              <tr>
                <th>Repository</th>
                <th>Revision</th>
                <th>Branch</th>
                <th>Registered</th>
              </tr>
            </thead>
            <tbody>
              {revisions.map((r) => (
                <tr key={r.id}>
                  <td>{r.repositoryRef}</td>
                  <td>{r.shortSha ?? r.revisionHash.slice(0, 7)}</td>
                  <td>{r.branch ?? "—"}</td>
                  <td>{r.registeredAt}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
