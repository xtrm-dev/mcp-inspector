import { useEffect, useState } from "react";
import { createWorkspaceNode, listWorkspaces } from "../api/client";
import type { WorkspaceRow } from "../api/types";

export interface CapabilitySelection {
  serverId: string;
  capabilityId: string;
  label: string;
}

interface Props {
  selections: CapabilitySelection[];
  onDismiss: () => void;
  onAdded: (count: number, workspaceId: string) => void;
}

export function AddToWorkspaceModal({ selections, onDismiss, onAdded }: Props) {
  const [workspaces, setWorkspaces] = useState<WorkspaceRow[]>([]);
  const [workspaceId, setWorkspaceId] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    listWorkspaces()
      .then((r) => {
        setWorkspaces(r.workspaces);
        setWorkspaceId((current) => current || r.workspaces[0]?.id || "");
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  async function handleSubmit() {
    if (!workspaceId) {
      setError("select a workspace");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      for (const sel of selections) {
        // ponytail: sequential to keep server-side event order stable for
        // small selection sets. If catalog batches grow, switch to
        // Promise.all with bounded concurrency.
        await createWorkspaceNode(workspaceId, {
          serverId: sel.serverId,
          capabilityId: sel.capabilityId,
          presentation: "collapsed",
        });
      }
      onAdded(selections.length, workspaceId);
      onDismiss();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-label="Add to workspace" data-testid="add-to-workspace-modal">
      <div className="modal-panel">
        <h3>Add {selections.length} capabilit{selections.length === 1 ? "y" : "ies"} to a workspace</h3>
        {error && <p className="form-error">{error}</p>}
        <ul className="modal-list">
          {selections.map((s) => (
            <li key={`${s.serverId}::${s.capabilityId}`}>
              <span className="muted">{s.serverId}</span> · {s.label}
            </li>
          ))}
        </ul>
        <label>
          Workspace
          <select
            value={workspaceId}
            onChange={(e) => setWorkspaceId(e.target.value)}
            data-testid="add-modal-workspace-select"
          >
            {workspaces.length === 0 && <option value="">(no workspaces)</option>}
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </label>
        <div className="modal-actions">
          <button type="button" onClick={onDismiss} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="button primary"
            onClick={handleSubmit}
            disabled={busy || selections.length === 0 || !workspaceId}
            data-testid="add-modal-submit"
          >
            {busy ? "Adding…" : "Add"}
          </button>
        </div>
      </div>
    </div>
  );
}
