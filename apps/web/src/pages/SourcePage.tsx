import { useEffect, useState } from "react";
import { listSourceRevisions, registerSourceRevision } from "../api/client";
import type { SourceRevision } from "../api/types";

// UX-7 slice 1: Implementation / Runtime / Combined mode toggle at the
// top of the page per dispatch §22. Slice 1 keeps the existing revision
// admin under Implementation mode; Runtime and Combined modes surface
// their intended IA now with explicit "requires runtime evidence"
// placeholders so operators see what will appear once evidence flows
// through, rather than empty tabs.
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
    "Runtime-confirmed edges observed on real executions. Requires trace evidence — connect a tracing sink and run tools to see the graph.",
  combined:
    "Overlay of Implementation + Runtime. Static edges dim; runtime edges highlight. Error paths mark distinctly.",
};

export function SourcePage() {
  const [mode, setMode] = useState<SourceMode>("implementation");
  const [revisions, setRevisions] = useState<SourceRevision[]>([]);
  const [repositoryRef, setRepositoryRef] = useState("");
  const [revisionHash, setRevisionHash] = useState("");
  const [error, setError] = useState<string | null>(null);

  function refresh() {
    listSourceRevisions({ limit: 100 })
      .then((res) => setRevisions(res.sourceRevisions))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }
  useEffect(refresh, []);

  async function handleRegister(e: React.FormEvent) {
    e.preventDefault();
    if (!repositoryRef.trim() || revisionHash.trim().length < 7) return;
    try {
      await registerSourceRevision({ repositoryRef: repositoryRef.trim(), revisionHash: revisionHash.trim() });
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

      {mode === "runtime" && (
        <div className="panel" data-testid="source-runtime-placeholder">
          <h3>Runtime graph</h3>
          <p className="muted">
            No runtime edges available yet. Runtime edges appear once tool calls have produced trace
            evidence with source correlation. Slice 2 wires the interactive graph — this slice
            establishes the mode contract.
          </p>
        </div>
      )}

      {mode === "combined" && (
        <div className="panel" data-testid="source-combined-placeholder">
          <h3>Combined graph</h3>
          <p className="muted">
            Overlay pending — combined visualization requires both a registered revision AND
            runtime evidence. Register a revision on the Implementation tab, then run a tool
            against a source-mapped capability to populate.
          </p>
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
          <input value={revisionHash} onChange={(e) => setRevisionHash(e.target.value)} minLength={7} />
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
