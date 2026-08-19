import { createHash } from "node:crypto";

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export interface AppliedMigration {
  version: number;
  name: string;
  applied_at: string;
  checksum: string;
}

const V1_SCHEMA = `
CREATE TABLE credential_ref (
  id            TEXT PRIMARY KEY,
  provider      TEXT NOT NULL,
  key           TEXT NOT NULL,
  scope         TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE server_definition (
  id                 TEXT PRIMARY KEY,
  display_name       TEXT NOT NULL,
  transport          TEXT NOT NULL,
  endpoint           TEXT,
  protocol_policy    TEXT NOT NULL,
  disabled           INTEGER NOT NULL DEFAULT 0,
  credential_ref_id  TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  FOREIGN KEY (credential_ref_id) REFERENCES credential_ref(id) ON DELETE SET NULL
);

CREATE TABLE capability_snapshot (
  id               TEXT PRIMARY KEY,
  server_id        TEXT NOT NULL,
  capability_type  TEXT NOT NULL,
  name             TEXT NOT NULL,
  revision         INTEGER NOT NULL,
  definition_json  TEXT NOT NULL,
  observed_at      TEXT NOT NULL,
  FOREIGN KEY (server_id) REFERENCES server_definition(id) ON DELETE CASCADE
);
CREATE INDEX idx_capability_snapshot_server
  ON capability_snapshot(server_id, capability_type, name);

CREATE TABLE workspace (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  layout_json  TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE workspace_node (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  server_id       TEXT,
  capability_id   TEXT,
  arguments_json  TEXT,
  presentation    TEXT NOT NULL DEFAULT 'collapsed',
  position        INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspace(id) ON DELETE CASCADE
);
CREATE INDEX idx_workspace_node_workspace ON workspace_node(workspace_id);

CREATE TABLE execution (
  id                 TEXT PRIMARY KEY,
  workspace_id       TEXT,
  workspace_node_id  TEXT,
  server_id          TEXT NOT NULL,
  capability_id      TEXT NOT NULL,
  status             TEXT NOT NULL,
  started_at         TEXT NOT NULL,
  ended_at           TEXT,
  FOREIGN KEY (workspace_id) REFERENCES workspace(id) ON DELETE SET NULL,
  FOREIGN KEY (workspace_node_id) REFERENCES workspace_node(id) ON DELETE SET NULL
);
CREATE INDEX idx_execution_started ON execution(started_at DESC);
CREATE INDEX idx_execution_capability ON execution(capability_id, started_at DESC);

CREATE TABLE execution_round (
  id                  TEXT PRIMARY KEY,
  execution_id        TEXT NOT NULL,
  round_index         INTEGER NOT NULL,
  kind                TEXT NOT NULL,
  arguments_json      TEXT,
  result_inline_json  TEXT,
  result_artifact     TEXT,
  error_json          TEXT,
  duration_ms         INTEGER,
  started_at          TEXT NOT NULL,
  ended_at            TEXT,
  UNIQUE (execution_id, round_index),
  FOREIGN KEY (execution_id) REFERENCES execution(id) ON DELETE CASCADE,
  FOREIGN KEY (result_artifact) REFERENCES artifact(hash) ON DELETE SET NULL
);

CREATE TABLE task_lifecycle (
  id             TEXT PRIMARY KEY,
  execution_id   TEXT NOT NULL,
  task_id        TEXT NOT NULL,
  status         TEXT NOT NULL,
  status_detail  TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  UNIQUE (execution_id, task_id),
  FOREIGN KEY (execution_id) REFERENCES execution(id) ON DELETE CASCADE
);

CREATE TABLE protocol_evidence_ref (
  id             TEXT PRIMARY KEY,
  execution_id   TEXT NOT NULL,
  round_id       TEXT,
  kind           TEXT NOT NULL,
  artifact_ref   TEXT NOT NULL,
  recorded_at    TEXT NOT NULL,
  FOREIGN KEY (execution_id) REFERENCES execution(id) ON DELETE CASCADE,
  FOREIGN KEY (round_id) REFERENCES execution_round(id) ON DELETE CASCADE,
  FOREIGN KEY (artifact_ref) REFERENCES artifact(hash) ON DELETE RESTRICT
);
CREATE INDEX idx_evidence_execution ON protocol_evidence_ref(execution_id);

CREATE TABLE capture_session (
  id             TEXT PRIMARY KEY,
  kind           TEXT NOT NULL,
  started_at     TEXT NOT NULL,
  ended_at       TEXT,
  metadata_json  TEXT
);

CREATE TABLE agent_run (
  id                   TEXT PRIMARY KEY,
  capture_session_id   TEXT NOT NULL,
  correlation_kind     TEXT NOT NULL,
  correlation_key      TEXT,
  started_at           TEXT NOT NULL,
  ended_at             TEXT,
  metadata_json        TEXT,
  FOREIGN KEY (capture_session_id) REFERENCES capture_session(id) ON DELETE CASCADE
);
CREATE INDEX idx_agent_run_correlation ON agent_run(correlation_kind, correlation_key);

CREATE TABLE artifact (
  hash        TEXT PRIMARY KEY,
  size        INTEGER NOT NULL,
  media_type  TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE execution_event (
  seq           INTEGER PRIMARY KEY AUTOINCREMENT,
  execution_id  TEXT,
  kind          TEXT NOT NULL,
  payload_json  TEXT NOT NULL,
  recorded_at   TEXT NOT NULL,
  FOREIGN KEY (execution_id) REFERENCES execution(id) ON DELETE CASCADE
);
CREATE INDEX idx_event_execution ON execution_event(execution_id, seq);
`;

// Phase L slice 1: link Executions to a CaptureSession + AgentRun so a
// multi-node workspace run (or later, a captured external-agent session)
// can be walked as one causal group.
const V2_AGENT_RUN_LINKS = `
ALTER TABLE execution ADD COLUMN capture_session_id TEXT
  REFERENCES capture_session(id) ON DELETE SET NULL;
ALTER TABLE execution ADD COLUMN agent_run_id TEXT
  REFERENCES agent_run(id) ON DELETE SET NULL;
CREATE INDEX idx_execution_agent_run ON execution(agent_run_id, started_at DESC);
CREATE INDEX idx_execution_capture_session ON execution(capture_session_id, started_at DESC);
`;

// Phase M slice 1: minimal trace table for ingested runtime traces. Each
// record carries a raw JSON blob of spans (OTLP-shaped later); AgentRun
// linkage lives in the correlation_kind='w3c-trace' path and is populated
// in Phase M slice 2.
const V3_TRACES = `
CREATE TABLE trace (
  id            TEXT PRIMARY KEY,
  trace_id      TEXT NOT NULL UNIQUE,
  span_count    INTEGER NOT NULL,
  spans_json    TEXT NOT NULL,
  ingested_at   TEXT NOT NULL,
  source        TEXT
);
CREATE INDEX idx_trace_ingested ON trace(ingested_at DESC);
`;

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: "schema-v1", sql: V1_SCHEMA },
  { version: 2, name: "agent-run-links", sql: V2_AGENT_RUN_LINKS },
  { version: 3, name: "traces", sql: V3_TRACES },
];

export function checksum(sql: string): string {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}
