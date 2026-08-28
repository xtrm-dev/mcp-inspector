import type { CompareResult, ExecutionRecord, JsonValue } from "../api/types";

// UX-5 slice 1: structured comparison of two ExecutionRecords. Replaces
// the pre-existing `<pre>{JSON.stringify(compareResult)}</pre>` dump in
// ExecutionsPage per dispatch §20 ("Comparison should be presented
// structurally, not as a raw <pre> dump"). Slice 2 (shared inspector)
// will unify this with the workspace-node inspection surface UX-2 is
// scaffolding; this slice ships the visible structural change now.

interface Props {
  compare: CompareResult;
}

interface Row {
  label: string;
  left: string | null;
  right: string | null;
  changed: boolean;
}

function fmt(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function metaRows(left: ExecutionRecord, right: ExecutionRecord): Row[] {
  const rows: Array<[string, unknown, unknown]> = [
    ["Status", left.status, right.status],
    ["Server", left.serverId, right.serverId],
    ["Capability", left.capabilityId, right.capabilityId],
    ["Started at", left.startedAt ?? "—", right.startedAt ?? "—"],
    ["Ended at", left.endedAt ?? "—", right.endedAt ?? "—"],
  ];
  return rows.map(([label, l, r]) => {
    const ls = fmt(l);
    const rs = fmt(r);
    return { label, left: ls, right: rs, changed: ls !== rs };
  });
}

function extraKeyRows(compare: CompareResult): Row[] {
  const skip = new Set(["left", "right"]);
  const rows: Row[] = [];
  for (const key of Object.keys(compare)) {
    if (skip.has(key)) continue;
    const val = compare[key];
    if (val === undefined) continue;
    if (typeof val === "object" && val !== null && "left" in val && "right" in val) {
      const pair = val as { left?: JsonValue; right?: JsonValue };
      const l = fmt(pair.left);
      const r = fmt(pair.right);
      rows.push({ label: key, left: l, right: r, changed: l !== r });
    } else {
      // Non-diff scalar — render both sides identically.
      const s = fmt(val);
      rows.push({ label: key, left: s, right: s, changed: false });
    }
  }
  return rows;
}

export function ComparisonView({ compare }: Props) {
  const meta = metaRows(compare.left, compare.right);
  const extras = extraKeyRows(compare);
  return (
    <div className="panel comparison-view" data-testid="comparison-view">
      <h3>Comparison</h3>
      <div className="comparison-lanes">
        <ComparisonLane title="Execution meta" rows={meta} />
        {extras.length > 0 && <ComparisonLane title="Compare fields" rows={extras} />}
      </div>
    </div>
  );
}

function ComparisonLane({ title, rows }: { title: string; rows: Row[] }) {
  const changed = rows.filter((r) => r.changed).length;
  return (
    <div className="comparison-lane">
      <div className="comparison-lane-head">
        <strong>{title}</strong>
        <span className="muted">
          {rows.length} field{rows.length === 1 ? "" : "s"} · {changed} changed
        </span>
      </div>
      <table className="data-table comparison-table">
        <thead>
          <tr>
            <th>Field</th>
            <th>Left</th>
            <th>Right</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label} className={r.changed ? "comparison-changed" : ""}>
              <td className="comparison-label">{r.label}</td>
              <td className="comparison-cell">
                {r.left === null ? <span className="muted">—</span> : r.left}
              </td>
              <td className="comparison-cell">
                {r.right === null ? <span className="muted">—</span> : r.right}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
