import { useEffect, useState } from "react";
import { createCredential, deleteCredential, listCredentials } from "../api/client";
import type { CredentialProvider, CredentialRef } from "../api/types";

export function CredentialsPage() {
  const [credentials, setCredentials] = useState<CredentialRef[]>([]);
  const [provider, setProvider] = useState<CredentialProvider>("env");
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);

  function refresh() {
    listCredentials()
      .then((res) => setCredentials(res.credentials))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }
  useEffect(refresh, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!key.trim()) return;
    try {
      await createCredential({ provider, key: key.trim() });
      setKey("");
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="page" data-testid="credentials-page">
      <h2>Credential registry</h2>
      <p className="muted">Metadata only — secret values are never returned by the API.</p>
      {error && <p className="form-error">{error}</p>}

      <form className="panel field-row" onSubmit={handleCreate}>
        <label>
          Provider
          <select value={provider} onChange={(e) => setProvider(e.target.value as CredentialProvider)}>
            <option value="env">env</option>
            <option value="os">os-keychain</option>
            <option value="session">session</option>
          </select>
        </label>
        <label>
          Key
          <input value={key} onChange={(e) => setKey(e.target.value)} />
        </label>
        <button className="button primary" type="submit">
          Register credential
        </button>
      </form>

      <table className="data-table">
        <thead>
          <tr>
            <th>Provider</th>
            <th>Key</th>
            <th>Scope</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {credentials.map((c) => (
            <tr key={c.id}>
              <td>{c.provider}</td>
              <td>{c.key}</td>
              <td>{c.scope ?? "—"}</td>
              <td>
                <button onClick={() => deleteCredential(c.id).then(refresh)}>Delete</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
