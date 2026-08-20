import { useEffect, useState } from "react";
import { buildInvestigationPacket, listExecutions } from "../api/client";
import type { ExecutionRecord, PacketFormat, PacketTier } from "../api/types";

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
