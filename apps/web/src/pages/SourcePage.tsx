import { useEffect, useState } from "react";
import { listSourceRevisions, registerSourceRevision } from "../api/client";
import type { SourceRevision } from "../api/types";

export function SourcePage() {
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
      <h2>Source revisions</h2>
      <p className="muted">
        Tool-call responses carry a `sourceHint` (file + symbol + line range) when the gateway has an indexed
        mapping — see it inline on a tool call result in the Servers view.
      </p>
      {error && <p className="form-error">{error}</p>}

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
    </div>
  );
}
