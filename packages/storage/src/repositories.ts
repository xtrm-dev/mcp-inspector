import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { SqliteDb } from "./database";

// ---------- Shared types ----------

export type Iso = string;
export type Json = string; // stringified JSON payload

function nowIso(): Iso {
  return new Date().toISOString();
}

// ---------- Credential references ----------

export type CredentialProvider = "env" | "os" | "session";

export interface CredentialRef {
  id: string;
  provider: CredentialProvider;
  key: string;
  scope: string | null;
  createdAt: Iso;
}

export interface CreateCredentialRefInput {
  id?: string;
  provider: CredentialProvider;
  key: string;
  scope?: string | null;
}

interface CredentialRefRow {
  id: string;
  provider: string;
  key: string;
  scope: string | null;
  created_at: string;
}

function rowToCredentialRef(row: CredentialRefRow): CredentialRef {
  return {
    id: row.id,
    provider: row.provider as CredentialProvider,
    key: row.key,
    scope: row.scope,
    createdAt: row.created_at,
  };
}

export interface CredentialRefRepository {
  create(input: CreateCredentialRefInput): CredentialRef;
  get(id: string): CredentialRef | null;
  list(): CredentialRef[];
  delete(id: string): void;
}

export function createCredentialRefRepository(db: SqliteDb): CredentialRefRepository {
  const insert = db.prepare(`
    INSERT INTO credential_ref (id, provider, key, scope, created_at)
    VALUES (@id, @provider, @key, @scope, @created_at)
  `);
  const getStmt = db.prepare("SELECT * FROM credential_ref WHERE id = ?");
  const listStmt = db.prepare("SELECT * FROM credential_ref ORDER BY created_at ASC");
  const delStmt = db.prepare("DELETE FROM credential_ref WHERE id = ?");

  return {
    create(input) {
      const id = input.id ?? randomUUID();
      const row: CredentialRefRow = {
        id,
        provider: input.provider,
        key: input.key,
        scope: input.scope ?? null,
        created_at: nowIso(),
      };
      insert.run(row);
      return rowToCredentialRef(row);
    },
    get(id) {
      const row = getStmt.get(id) as CredentialRefRow | undefined;
      return row ? rowToCredentialRef(row) : null;
    },
    list() {
      return (listStmt.all() as CredentialRefRow[]).map(rowToCredentialRef);
    },
    delete(id) {
      delStmt.run(id);
    },
  };
}

// ---------- Server definitions ----------

export type Transport = "streamable-http" | "sse" | "stdio";
export type ProtocolPolicy = "auto" | "modern" | "legacy";

export interface ServerDefinition {
  id: string;
  displayName: string;
  transport: Transport;
  endpoint: string | null;
  // stdio-only launch parameters (null for streamable-http/sse).
  command: string | null;
  args: string[] | null;
  cwd: string | null;
  env: Record<string, string> | null;
  protocolPolicy: ProtocolPolicy;
  disabled: boolean;
  credentialRefId: string | null;
  createdAt: Iso;
  updatedAt: Iso;
}

export interface UpsertServerInput {
  id?: string;
  displayName: string;
  transport: Transport;
  endpoint?: string | null;
  command?: string | null;
  args?: string[] | null;
  cwd?: string | null;
  env?: Record<string, string> | null;
  protocolPolicy?: ProtocolPolicy;
  disabled?: boolean;
  credentialRefId?: string | null;
}

interface ServerRow {
  id: string;
  display_name: string;
  transport: string;
  endpoint: string | null;
  command: string | null;
  args_json: string | null;
  cwd: string | null;
  env_json: string | null;
  protocol_policy: string;
  disabled: number;
  credential_ref_id: string | null;
  created_at: string;
  updated_at: string;
}

function rowToServer(row: ServerRow): ServerDefinition {
  return {
    id: row.id,
    displayName: row.display_name,
    transport: row.transport as Transport,
    endpoint: row.endpoint,
    command: row.command,
    args: row.args_json !== null ? (JSON.parse(row.args_json) as string[]) : null,
    cwd: row.cwd,
    env: row.env_json !== null ? (JSON.parse(row.env_json) as Record<string, string>) : null,
    protocolPolicy: row.protocol_policy as ProtocolPolicy,
    disabled: row.disabled === 1,
    credentialRefId: row.credential_ref_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface ServerRepository {
  create(input: UpsertServerInput): ServerDefinition;
  upsertById(input: UpsertServerInput & { id: string }): ServerDefinition;
  get(id: string): ServerDefinition | null;
  list(): ServerDefinition[];
  update(id: string, patch: Partial<UpsertServerInput>): ServerDefinition;
  delete(id: string): void;
}

export function createServerRepository(db: SqliteDb): ServerRepository {
  const insert = db.prepare(`
    INSERT INTO server_definition
      (id, display_name, transport, endpoint, command, args_json, cwd, env_json, protocol_policy, disabled, credential_ref_id, created_at, updated_at)
    VALUES (@id, @display_name, @transport, @endpoint, @command, @args_json, @cwd, @env_json, @protocol_policy, @disabled, @credential_ref_id, @created_at, @updated_at)
  `);
  const upsert = db.prepare(`
    INSERT INTO server_definition
      (id, display_name, transport, endpoint, command, args_json, cwd, env_json, protocol_policy, disabled, credential_ref_id, created_at, updated_at)
    VALUES (@id, @display_name, @transport, @endpoint, @command, @args_json, @cwd, @env_json, @protocol_policy, @disabled, @credential_ref_id, @created_at, @updated_at)
    ON CONFLICT(id) DO UPDATE SET
      display_name = excluded.display_name,
      transport = excluded.transport,
      endpoint = excluded.endpoint,
      command = excluded.command,
      args_json = excluded.args_json,
      cwd = excluded.cwd,
      env_json = excluded.env_json,
      protocol_policy = excluded.protocol_policy,
      disabled = excluded.disabled,
      credential_ref_id = excluded.credential_ref_id,
      updated_at = excluded.updated_at
  `);
  const getStmt = db.prepare("SELECT * FROM server_definition WHERE id = ?");
  const listStmt = db.prepare("SELECT * FROM server_definition ORDER BY created_at ASC");
  const delStmt = db.prepare("DELETE FROM server_definition WHERE id = ?");

  function build(input: UpsertServerInput, id: string, now: Iso): Record<string, unknown> {
    return {
      id,
      display_name: input.displayName,
      transport: input.transport,
      endpoint: input.endpoint ?? null,
      command: input.command ?? null,
      args_json: input.args ? JSON.stringify(input.args) : null,
      cwd: input.cwd ?? null,
      env_json: input.env ? JSON.stringify(input.env) : null,
      protocol_policy: input.protocolPolicy ?? "auto",
      disabled: input.disabled ? 1 : 0,
      credential_ref_id: input.credentialRefId ?? null,
      created_at: now,
      updated_at: now,
    };
  }

  return {
    create(input) {
      const id = input.id ?? randomUUID();
      const now = nowIso();
      insert.run(build(input, id, now));
      return get(id);
    },
    upsertById(input) {
      const now = nowIso();
      upsert.run(build(input, input.id, now));
      return get(input.id);
    },
    get(id) {
      const row = getStmt.get(id) as ServerRow | undefined;
      return row ? rowToServer(row) : null;
    },
    list() {
      return (listStmt.all() as ServerRow[]).map(rowToServer);
    },
    update(id, patch) {
      const current = get(id);
      const now = nowIso();
      const merged: UpsertServerInput = {
        displayName: patch.displayName ?? current.displayName,
        transport: patch.transport ?? current.transport,
        endpoint: patch.endpoint !== undefined ? patch.endpoint : current.endpoint,
        command: patch.command !== undefined ? patch.command : current.command,
        args: patch.args !== undefined ? patch.args : current.args,
        cwd: patch.cwd !== undefined ? patch.cwd : current.cwd,
        env: patch.env !== undefined ? patch.env : current.env,
        protocolPolicy: patch.protocolPolicy ?? current.protocolPolicy,
        disabled: patch.disabled ?? current.disabled,
        credentialRefId:
          patch.credentialRefId !== undefined ? patch.credentialRefId : current.credentialRefId,
      };
      upsert.run(build(merged, id, now));
      return get(id);
    },
    delete(id) {
      delStmt.run(id);
    },
  };

  function get(id: string): ServerDefinition {
    const row = getStmt.get(id) as ServerRow | undefined;
    if (!row) throw new Error(`server_definition ${id} not found`);
    return rowToServer(row);
  }
}

// ---------- Workspaces ----------

export interface Workspace {
  id: string;
  name: string;
  layoutJson: Json;
  createdAt: Iso;
  updatedAt: Iso;
}

export interface CreateWorkspaceInput {
  id?: string;
  name: string;
  layoutJson?: Json;
}

export interface UpdateWorkspaceInput {
  name?: string;
  layoutJson?: Json;
}

interface WorkspaceRow {
  id: string;
  name: string;
  layout_json: string;
  created_at: string;
  updated_at: string;
}

function rowToWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    name: row.name,
    layoutJson: row.layout_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export type WorkspaceNodePresentation = "collapsed" | "expanded" | "focus";

export interface WorkspaceNode {
  id: string;
  workspaceId: string;
  serverId: string | null;
  capabilityId: string | null;
  argumentsJson: Json | null;
  presentation: WorkspaceNodePresentation;
  position: number;
  createdAt: Iso;
  updatedAt: Iso;
}

export interface CreateWorkspaceNodeInput {
  id?: string;
  workspaceId: string;
  serverId?: string | null;
  capabilityId?: string | null;
  argumentsJson?: Json | null;
  presentation?: WorkspaceNodePresentation;
  position?: number;
}

export interface UpdateWorkspaceNodeInput {
  serverId?: string | null;
  capabilityId?: string | null;
  argumentsJson?: Json | null;
  presentation?: WorkspaceNodePresentation;
  position?: number;
}

interface WorkspaceNodeRow {
  id: string;
  workspace_id: string;
  server_id: string | null;
  capability_id: string | null;
  arguments_json: string | null;
  presentation: string;
  position: number;
  created_at: string;
  updated_at: string;
}

function rowToNode(row: WorkspaceNodeRow): WorkspaceNode {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    serverId: row.server_id,
    capabilityId: row.capability_id,
    argumentsJson: row.arguments_json,
    presentation: row.presentation as WorkspaceNodePresentation,
    position: row.position,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface WorkspaceRepository {
  create(input: CreateWorkspaceInput): Workspace;
  get(id: string): Workspace | null;
  list(): Workspace[];
  update(id: string, patch: UpdateWorkspaceInput): Workspace;
  delete(id: string): void;
}

export function createWorkspaceRepository(db: SqliteDb): WorkspaceRepository {
  const insert = db.prepare(`
    INSERT INTO workspace (id, name, layout_json, created_at, updated_at)
    VALUES (@id, @name, @layout_json, @created_at, @updated_at)
  `);
  const getStmt = db.prepare("SELECT * FROM workspace WHERE id = ?");
  const listStmt = db.prepare("SELECT * FROM workspace ORDER BY updated_at DESC");
  const updateStmt = db.prepare(`
    UPDATE workspace SET name = @name, layout_json = @layout_json, updated_at = @updated_at WHERE id = @id
  `);
  const delStmt = db.prepare("DELETE FROM workspace WHERE id = ?");

  function getOrThrow(id: string): Workspace {
    const row = getStmt.get(id) as WorkspaceRow | undefined;
    if (!row) throw new Error(`workspace ${id} not found`);
    return rowToWorkspace(row);
  }

  return {
    create(input) {
      const id = input.id ?? randomUUID();
      const now = nowIso();
      insert.run({
        id,
        name: input.name,
        layout_json: input.layoutJson ?? "{}",
        created_at: now,
        updated_at: now,
      });
      return getOrThrow(id);
    },
    get(id) {
      const row = getStmt.get(id) as WorkspaceRow | undefined;
      return row ? rowToWorkspace(row) : null;
    },
    list() {
      return (listStmt.all() as WorkspaceRow[]).map(rowToWorkspace);
    },
    update(id, patch) {
      const current = getOrThrow(id);
      const now = nowIso();
      updateStmt.run({
        id,
        name: patch.name ?? current.name,
        layout_json: patch.layoutJson ?? current.layoutJson,
        updated_at: now,
      });
      return getOrThrow(id);
    },
    delete(id) {
      delStmt.run(id);
    },
  };
}

export interface WorkspaceNodeRepository {
  create(input: CreateWorkspaceNodeInput): WorkspaceNode;
  get(id: string): WorkspaceNode | null;
  listForWorkspace(workspaceId: string): WorkspaceNode[];
  update(id: string, patch: UpdateWorkspaceNodeInput): WorkspaceNode;
  delete(id: string): void;
  reorder(workspaceId: string, orderedIds: string[]): WorkspaceNode[];
}

export function createWorkspaceNodeRepository(db: SqliteDb): WorkspaceNodeRepository {
  const insert = db.prepare(`
    INSERT INTO workspace_node
      (id, workspace_id, server_id, capability_id, arguments_json, presentation, position, created_at, updated_at)
    VALUES
      (@id, @workspace_id, @server_id, @capability_id, @arguments_json, @presentation, @position, @created_at, @updated_at)
  `);
  const getStmt = db.prepare("SELECT * FROM workspace_node WHERE id = ?");
  const listStmt = db.prepare(
    "SELECT * FROM workspace_node WHERE workspace_id = ? ORDER BY position ASC, created_at ASC",
  );
  const updateStmt = db.prepare(`
    UPDATE workspace_node
    SET server_id = @server_id,
        capability_id = @capability_id,
        arguments_json = @arguments_json,
        presentation = @presentation,
        position = @position,
        updated_at = @updated_at
    WHERE id = @id
  `);
  const delStmt = db.prepare("DELETE FROM workspace_node WHERE id = ?");
  const posStmt = db.prepare(
    "UPDATE workspace_node SET position = ? WHERE id = ? AND workspace_id = ?",
  );

  function getOrThrow(id: string): WorkspaceNode {
    const row = getStmt.get(id) as WorkspaceNodeRow | undefined;
    if (!row) throw new Error(`workspace_node ${id} not found`);
    return rowToNode(row);
  }

  return {
    create(input) {
      const id = input.id ?? randomUUID();
      const now = nowIso();
      insert.run({
        id,
        workspace_id: input.workspaceId,
        server_id: input.serverId ?? null,
        capability_id: input.capabilityId ?? null,
        arguments_json: input.argumentsJson ?? null,
        presentation: input.presentation ?? "collapsed",
        position: input.position ?? 0,
        created_at: now,
        updated_at: now,
      });
      return getOrThrow(id);
    },
    get(id) {
      const row = getStmt.get(id) as WorkspaceNodeRow | undefined;
      return row ? rowToNode(row) : null;
    },
    listForWorkspace(workspaceId) {
      return (listStmt.all(workspaceId) as WorkspaceNodeRow[]).map(rowToNode);
    },
    update(id, patch) {
      const current = getOrThrow(id);
      const now = nowIso();
      updateStmt.run({
        id,
        server_id: patch.serverId !== undefined ? patch.serverId : current.serverId,
        capability_id: patch.capabilityId !== undefined ? patch.capabilityId : current.capabilityId,
        arguments_json:
          patch.argumentsJson !== undefined ? patch.argumentsJson : current.argumentsJson,
        presentation: patch.presentation ?? current.presentation,
        position: patch.position ?? current.position,
        updated_at: now,
      });
      return getOrThrow(id);
    },
    delete(id) {
      delStmt.run(id);
    },
    reorder(workspaceId, orderedIds) {
      const tx = db.transaction((ids: string[]) => {
        ids.forEach((nodeId, idx) => posStmt.run(idx, nodeId, workspaceId));
      });
      tx(orderedIds);
      return (listStmt.all(workspaceId) as WorkspaceNodeRow[]).map(rowToNode);
    },
  };
}

// ---------- Executions ----------

export interface ExecutionRecord {
  id: string;
  workspaceId: string | null;
  workspaceNodeId: string | null;
  captureSessionId: string | null;
  agentRunId: string | null;
  serverId: string;
  capabilityId: string;
  status: string;
  startedAt: Iso;
  endedAt: Iso | null;
}

export interface CreateExecutionInput {
  id?: string;
  workspaceId?: string | null;
  workspaceNodeId?: string | null;
  captureSessionId?: string | null;
  agentRunId?: string | null;
  serverId: string;
  capabilityId: string;
  status?: string;
}

interface ExecutionRow {
  id: string;
  workspace_id: string | null;
  workspace_node_id: string | null;
  capture_session_id: string | null;
  agent_run_id: string | null;
  server_id: string;
  capability_id: string;
  status: string;
  started_at: string;
  ended_at: string | null;
}

function rowToExecution(row: ExecutionRow): ExecutionRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    workspaceNodeId: row.workspace_node_id,
    captureSessionId: row.capture_session_id,
    agentRunId: row.agent_run_id,
    serverId: row.server_id,
    capabilityId: row.capability_id,
    status: row.status,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
}

export interface ExecutionRepository {
  create(input: CreateExecutionInput): ExecutionRecord;
  get(id: string): ExecutionRecord | null;
  list(opts?: { limit?: number }): ExecutionRecord[];
  listForCapability(capabilityId: string, opts?: { limit?: number }): ExecutionRecord[];
  listForAgentRun(agentRunId: string, opts?: { limit?: number }): ExecutionRecord[];
  updateStatus(id: string, status: string, endedAt?: Iso | null): ExecutionRecord;
}

export function createExecutionRepository(db: SqliteDb): ExecutionRepository {
  const insert = db.prepare(`
    INSERT INTO execution
      (id, workspace_id, workspace_node_id, capture_session_id, agent_run_id,
       server_id, capability_id, status, started_at, ended_at)
    VALUES (@id, @workspace_id, @workspace_node_id, @capture_session_id, @agent_run_id,
            @server_id, @capability_id, @status, @started_at, @ended_at)
  `);
  const getStmt = db.prepare("SELECT * FROM execution WHERE id = ?");
  const listStmt = db.prepare("SELECT * FROM execution ORDER BY started_at DESC LIMIT ?");
  const listCapStmt = db.prepare(
    "SELECT * FROM execution WHERE capability_id = ? ORDER BY started_at DESC LIMIT ?",
  );
  const listAgentStmt = db.prepare(
    "SELECT * FROM execution WHERE agent_run_id = ? ORDER BY started_at ASC LIMIT ?",
  );
  const updateStmt = db.prepare(
    "UPDATE execution SET status = @status, ended_at = @ended_at WHERE id = @id",
  );

  return {
    create(input) {
      const id = input.id ?? randomUUID();
      const row = {
        id,
        workspace_id: input.workspaceId ?? null,
        workspace_node_id: input.workspaceNodeId ?? null,
        capture_session_id: input.captureSessionId ?? null,
        agent_run_id: input.agentRunId ?? null,
        server_id: input.serverId,
        capability_id: input.capabilityId,
        status: input.status ?? "queued",
        started_at: nowIso(),
        ended_at: null as string | null,
      };
      insert.run(row);
      return rowToExecution(row as ExecutionRow);
    },
    get(id) {
      const row = getStmt.get(id) as ExecutionRow | undefined;
      return row ? rowToExecution(row) : null;
    },
    list(opts) {
      const rows = listStmt.all(opts?.limit ?? 100) as ExecutionRow[];
      return rows.map(rowToExecution);
    },
    listForCapability(capabilityId, opts) {
      const rows = listCapStmt.all(capabilityId, opts?.limit ?? 100) as ExecutionRow[];
      return rows.map(rowToExecution);
    },
    listForAgentRun(agentRunId, opts) {
      const rows = listAgentStmt.all(agentRunId, opts?.limit ?? 1000) as ExecutionRow[];
      return rows.map(rowToExecution);
    },
    updateStatus(id, status, endedAt) {
      updateStmt.run({ id, status, ended_at: endedAt ?? null });
      const row = getStmt.get(id) as ExecutionRow | undefined;
      if (!row) throw new Error(`execution ${id} not found`);
      return rowToExecution(row);
    },
  };
}

// ---------- Execution rounds ----------

export type RoundKind = "initial" | "input_response" | "retry";

export interface ExecutionRound {
  id: string;
  executionId: string;
  roundIndex: number;
  kind: RoundKind;
  argumentsJson: Json | null;
  resultInlineJson: Json | null;
  resultArtifact: string | null;
  errorJson: Json | null;
  durationMs: number | null;
  startedAt: Iso;
  endedAt: Iso | null;
}

export interface AppendRoundInput {
  executionId: string;
  roundIndex: number;
  kind: RoundKind;
  argumentsJson?: Json | null;
  resultInlineJson?: Json | null;
  resultArtifact?: string | null;
  errorJson?: Json | null;
  durationMs?: number | null;
  startedAt?: Iso;
  endedAt?: Iso | null;
}

interface RoundRow {
  id: string;
  execution_id: string;
  round_index: number;
  kind: string;
  arguments_json: string | null;
  result_inline_json: string | null;
  result_artifact: string | null;
  error_json: string | null;
  duration_ms: number | null;
  started_at: string;
  ended_at: string | null;
}

function rowToRound(row: RoundRow): ExecutionRound {
  return {
    id: row.id,
    executionId: row.execution_id,
    roundIndex: row.round_index,
    kind: row.kind as RoundKind,
    argumentsJson: row.arguments_json,
    resultInlineJson: row.result_inline_json,
    resultArtifact: row.result_artifact,
    errorJson: row.error_json,
    durationMs: row.duration_ms,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
}

export interface ExecutionRoundRepository {
  append(input: AppendRoundInput): ExecutionRound;
  listForExecution(executionId: string): ExecutionRound[];
}

export function createExecutionRoundRepository(db: SqliteDb): ExecutionRoundRepository {
  const insert = db.prepare(`
    INSERT INTO execution_round
      (id, execution_id, round_index, kind, arguments_json, result_inline_json, result_artifact,
       error_json, duration_ms, started_at, ended_at)
    VALUES
      (@id, @execution_id, @round_index, @kind, @arguments_json, @result_inline_json, @result_artifact,
       @error_json, @duration_ms, @started_at, @ended_at)
  `);
  const listStmt = db.prepare(
    "SELECT * FROM execution_round WHERE execution_id = ? ORDER BY round_index ASC",
  );

  return {
    append(input) {
      const row: RoundRow = {
        id: randomUUID(),
        execution_id: input.executionId,
        round_index: input.roundIndex,
        kind: input.kind,
        arguments_json: input.argumentsJson ?? null,
        result_inline_json: input.resultInlineJson ?? null,
        result_artifact: input.resultArtifact ?? null,
        error_json: input.errorJson ?? null,
        duration_ms: input.durationMs ?? null,
        started_at: input.startedAt ?? nowIso(),
        ended_at: input.endedAt ?? null,
      };
      insert.run(row);
      return rowToRound(row);
    },
    listForExecution(executionId) {
      return (listStmt.all(executionId) as RoundRow[]).map(rowToRound);
    },
  };
}

// ---------- Protocol evidence refs ----------

export type EvidenceKind =
  | "raw_request"
  | "raw_response"
  | "negotiation"
  | "transport"
  | "process"
  | "notification";

export interface EvidenceRef {
  id: string;
  executionId: string;
  roundId: string | null;
  kind: EvidenceKind;
  artifactRef: string;
  recordedAt: Iso;
}

export interface AppendEvidenceInput {
  executionId: string;
  roundId?: string | null;
  kind: EvidenceKind;
  artifactRef: string;
}

interface EvidenceRow {
  id: string;
  execution_id: string;
  round_id: string | null;
  kind: string;
  artifact_ref: string;
  recorded_at: string;
}

function rowToEvidence(row: EvidenceRow): EvidenceRef {
  return {
    id: row.id,
    executionId: row.execution_id,
    roundId: row.round_id,
    kind: row.kind as EvidenceKind,
    artifactRef: row.artifact_ref,
    recordedAt: row.recorded_at,
  };
}

export interface EvidenceRepository {
  append(input: AppendEvidenceInput): EvidenceRef;
  listForExecution(executionId: string): EvidenceRef[];
}

export function createEvidenceRepository(db: SqliteDb): EvidenceRepository {
  const insert = db.prepare(`
    INSERT INTO protocol_evidence_ref (id, execution_id, round_id, kind, artifact_ref, recorded_at)
    VALUES (@id, @execution_id, @round_id, @kind, @artifact_ref, @recorded_at)
  `);
  const listStmt = db.prepare(
    "SELECT * FROM protocol_evidence_ref WHERE execution_id = ? ORDER BY recorded_at ASC",
  );

  return {
    append(input) {
      const row: EvidenceRow = {
        id: randomUUID(),
        execution_id: input.executionId,
        round_id: input.roundId ?? null,
        kind: input.kind,
        artifact_ref: input.artifactRef,
        recorded_at: nowIso(),
      };
      insert.run(row);
      return rowToEvidence(row);
    },
    listForExecution(executionId) {
      return (listStmt.all(executionId) as EvidenceRow[]).map(rowToEvidence);
    },
  };
}

// ---------- Capture sessions + agent runs ----------

export type CaptureKind =
  | "inspector"
  | "gateway-http"
  | "stdio-proxy"
  | "trace-ingest"
  | "adapter"
  | "workspace-run";

export interface CaptureSession {
  id: string;
  kind: CaptureKind;
  startedAt: Iso;
  endedAt: Iso | null;
  metadata: unknown;
}

export interface CreateCaptureSessionInput {
  id?: string;
  kind: CaptureKind;
  metadata?: unknown;
}

interface CaptureSessionRow {
  id: string;
  kind: string;
  started_at: string;
  ended_at: string | null;
  metadata_json: string | null;
}

function rowToCaptureSession(row: CaptureSessionRow): CaptureSession {
  return {
    id: row.id,
    kind: row.kind as CaptureKind,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    metadata: row.metadata_json ? JSON.parse(row.metadata_json) : null,
  };
}

export interface CaptureSessionRepository {
  create(input: CreateCaptureSessionInput): CaptureSession;
  get(id: string): CaptureSession | null;
  list(opts?: { limit?: number }): CaptureSession[];
  end(id: string): CaptureSession;
}

export function createCaptureSessionRepository(db: SqliteDb): CaptureSessionRepository {
  const insert = db.prepare(`
    INSERT INTO capture_session (id, kind, started_at, ended_at, metadata_json)
    VALUES (@id, @kind, @started_at, NULL, @metadata_json)
  `);
  const getStmt = db.prepare("SELECT * FROM capture_session WHERE id = ?");
  const listStmt = db.prepare("SELECT * FROM capture_session ORDER BY started_at DESC LIMIT ?");
  const endStmt = db.prepare("UPDATE capture_session SET ended_at = ? WHERE id = ?");

  function getOrThrow(id: string): CaptureSession {
    const row = getStmt.get(id) as CaptureSessionRow | undefined;
    if (!row) throw new Error(`capture_session ${id} not found`);
    return rowToCaptureSession(row);
  }

  return {
    create(input) {
      const id = input.id ?? randomUUID();
      insert.run({
        id,
        kind: input.kind,
        started_at: nowIso(),
        metadata_json: input.metadata === undefined ? null : JSON.stringify(input.metadata),
      });
      return getOrThrow(id);
    },
    get(id) {
      const row = getStmt.get(id) as CaptureSessionRow | undefined;
      return row ? rowToCaptureSession(row) : null;
    },
    list(opts) {
      return (listStmt.all(opts?.limit ?? 100) as CaptureSessionRow[]).map(rowToCaptureSession);
    },
    end(id) {
      endStmt.run(nowIso(), id);
      return getOrThrow(id);
    },
  };
}

export type CorrelationKind = "w3c-trace" | "inspector-run" | "protocol" | "inference";

export interface AgentRun {
  id: string;
  captureSessionId: string;
  correlationKind: CorrelationKind;
  correlationKey: string | null;
  startedAt: Iso;
  endedAt: Iso | null;
  metadata: unknown;
}

export interface CreateAgentRunInput {
  id?: string;
  captureSessionId: string;
  correlationKind: CorrelationKind;
  correlationKey?: string | null;
  metadata?: unknown;
}

interface AgentRunRow {
  id: string;
  capture_session_id: string;
  correlation_kind: string;
  correlation_key: string | null;
  started_at: string;
  ended_at: string | null;
  metadata_json: string | null;
}

function rowToAgentRun(row: AgentRunRow): AgentRun {
  return {
    id: row.id,
    captureSessionId: row.capture_session_id,
    correlationKind: row.correlation_kind as CorrelationKind,
    correlationKey: row.correlation_key,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    metadata: row.metadata_json ? JSON.parse(row.metadata_json) : null,
  };
}

export interface AgentRunRepository {
  create(input: CreateAgentRunInput): AgentRun;
  get(id: string): AgentRun | null;
  list(opts?: { limit?: number }): AgentRun[];
  listForCaptureSession(captureSessionId: string): AgentRun[];
  end(id: string): AgentRun;
}

export function createAgentRunRepository(db: SqliteDb): AgentRunRepository {
  const insert = db.prepare(`
    INSERT INTO agent_run
      (id, capture_session_id, correlation_kind, correlation_key, started_at, ended_at, metadata_json)
    VALUES
      (@id, @capture_session_id, @correlation_kind, @correlation_key, @started_at, NULL, @metadata_json)
  `);
  const getStmt = db.prepare("SELECT * FROM agent_run WHERE id = ?");
  const listStmt = db.prepare("SELECT * FROM agent_run ORDER BY started_at DESC LIMIT ?");
  const listForSessionStmt = db.prepare(
    "SELECT * FROM agent_run WHERE capture_session_id = ? ORDER BY started_at ASC",
  );
  const endStmt = db.prepare("UPDATE agent_run SET ended_at = ? WHERE id = ?");

  function getOrThrow(id: string): AgentRun {
    const row = getStmt.get(id) as AgentRunRow | undefined;
    if (!row) throw new Error(`agent_run ${id} not found`);
    return rowToAgentRun(row);
  }

  return {
    create(input) {
      const id = input.id ?? randomUUID();
      insert.run({
        id,
        capture_session_id: input.captureSessionId,
        correlation_kind: input.correlationKind,
        correlation_key: input.correlationKey ?? null,
        started_at: nowIso(),
        metadata_json: input.metadata === undefined ? null : JSON.stringify(input.metadata),
      });
      return getOrThrow(id);
    },
    get(id) {
      const row = getStmt.get(id) as AgentRunRow | undefined;
      return row ? rowToAgentRun(row) : null;
    },
    list(opts) {
      return (listStmt.all(opts?.limit ?? 100) as AgentRunRow[]).map(rowToAgentRun);
    },
    listForCaptureSession(captureSessionId) {
      return (listForSessionStmt.all(captureSessionId) as AgentRunRow[]).map(rowToAgentRun);
    },
    end(id) {
      endStmt.run(nowIso(), id);
      return getOrThrow(id);
    },
  };
}

// ---------- Traces ----------

export interface TraceRecord {
  id: string;
  traceId: string;
  spanCount: number;
  spans: unknown;
  ingestedAt: Iso;
  source: string | null;
}

export interface PutTraceInput {
  traceId: string;
  spans: unknown[];
  source?: string;
}

interface TraceRow {
  id: string;
  trace_id: string;
  span_count: number;
  spans_json: string;
  ingested_at: string;
  source: string | null;
}

function rowToTrace(row: TraceRow): TraceRecord {
  return {
    id: row.id,
    traceId: row.trace_id,
    spanCount: row.span_count,
    spans: JSON.parse(row.spans_json),
    ingestedAt: row.ingested_at,
    source: row.source,
  };
}

export interface TraceRepository {
  put(input: PutTraceInput): TraceRecord;
  get(traceId: string): TraceRecord | null;
  list(opts?: { limit?: number }): TraceRecord[];
  delete(traceId: string): void;
}

export function createTraceRepository(db: SqliteDb): TraceRepository {
  const upsert = db.prepare(`
    INSERT INTO trace (id, trace_id, span_count, spans_json, ingested_at, source)
    VALUES (@id, @trace_id, @span_count, @spans_json, @ingested_at, @source)
    ON CONFLICT(trace_id) DO UPDATE SET
      span_count  = excluded.span_count,
      spans_json  = excluded.spans_json,
      ingested_at = excluded.ingested_at,
      source      = excluded.source
  `);
  const getStmt = db.prepare("SELECT * FROM trace WHERE trace_id = ?");
  const listStmt = db.prepare("SELECT * FROM trace ORDER BY ingested_at DESC LIMIT ?");
  const delStmt = db.prepare("DELETE FROM trace WHERE trace_id = ?");

  return {
    put(input) {
      const id = randomUUID();
      const spansJson = JSON.stringify(input.spans);
      upsert.run({
        id,
        trace_id: input.traceId,
        span_count: input.spans.length,
        spans_json: spansJson,
        ingested_at: nowIso(),
        source: input.source ?? null,
      });
      const row = getStmt.get(input.traceId) as TraceRow;
      return rowToTrace(row);
    },
    get(traceId) {
      const row = getStmt.get(traceId) as TraceRow | undefined;
      return row ? rowToTrace(row) : null;
    },
    list(opts) {
      return (listStmt.all(opts?.limit ?? 100) as TraceRow[]).map(rowToTrace);
    },
    delete(traceId) {
      delStmt.run(traceId);
    },
  };
}

// ---------- Source revisions ----------

export interface SourceRevision {
  id: string;
  repositoryRef: string;
  revisionHash: string;
  branch: string | null;
  shortSha: string | null;
  registeredAt: Iso;
  metadata: unknown;
}

export interface RegisterSourceRevisionInput {
  id?: string;
  repositoryRef: string;
  revisionHash: string;
  branch?: string | null;
  shortSha?: string | null;
  metadata?: unknown;
}

interface SourceRevisionRow {
  id: string;
  repository_ref: string;
  revision_hash: string;
  branch: string | null;
  short_sha: string | null;
  registered_at: string;
  metadata_json: string | null;
}

function rowToSourceRevision(row: SourceRevisionRow): SourceRevision {
  return {
    id: row.id,
    repositoryRef: row.repository_ref,
    revisionHash: row.revision_hash,
    branch: row.branch,
    shortSha: row.short_sha,
    registeredAt: row.registered_at,
    metadata: row.metadata_json ? JSON.parse(row.metadata_json) : null,
  };
}

export interface SourceRevisionRepository {
  register(input: RegisterSourceRevisionInput): SourceRevision;
  get(id: string): SourceRevision | null;
  getByHash(repositoryRef: string, revisionHash: string): SourceRevision | null;
  listForRepository(repositoryRef: string, opts?: { limit?: number }): SourceRevision[];
  list(opts?: { limit?: number }): SourceRevision[];
}

export function createSourceRevisionRepository(db: SqliteDb): SourceRevisionRepository {
  const upsert = db.prepare(`
    INSERT INTO source_revision
      (id, repository_ref, revision_hash, branch, short_sha, registered_at, metadata_json)
    VALUES
      (@id, @repository_ref, @revision_hash, @branch, @short_sha, @registered_at, @metadata_json)
    ON CONFLICT(repository_ref, revision_hash) DO UPDATE SET
      branch     = excluded.branch,
      short_sha  = excluded.short_sha,
      metadata_json = excluded.metadata_json
  `);
  const getStmt = db.prepare("SELECT * FROM source_revision WHERE id = ?");
  const getByHashStmt = db.prepare(
    "SELECT * FROM source_revision WHERE repository_ref = ? AND revision_hash = ?",
  );
  const listRepoStmt = db.prepare(
    "SELECT * FROM source_revision WHERE repository_ref = ? ORDER BY registered_at DESC LIMIT ?",
  );
  const listStmt = db.prepare(
    "SELECT * FROM source_revision ORDER BY registered_at DESC LIMIT ?",
  );

  return {
    register(input) {
      const id = input.id ?? randomUUID();
      const shortSha = input.shortSha ?? (input.revisionHash.length >= 7 ? input.revisionHash.slice(0, 7) : null);
      upsert.run({
        id,
        repository_ref: input.repositoryRef,
        revision_hash: input.revisionHash,
        branch: input.branch ?? null,
        short_sha: shortSha,
        registered_at: nowIso(),
        metadata_json: input.metadata === undefined ? null : JSON.stringify(input.metadata),
      });
      const row =
        (getStmt.get(id) as SourceRevisionRow | undefined) ??
        (getByHashStmt.get(input.repositoryRef, input.revisionHash) as SourceRevisionRow);
      return rowToSourceRevision(row);
    },
    get(id) {
      const row = getStmt.get(id) as SourceRevisionRow | undefined;
      return row ? rowToSourceRevision(row) : null;
    },
    getByHash(repositoryRef, revisionHash) {
      const row = getByHashStmt.get(repositoryRef, revisionHash) as SourceRevisionRow | undefined;
      return row ? rowToSourceRevision(row) : null;
    },
    listForRepository(repositoryRef, opts) {
      return (listRepoStmt.all(repositoryRef, opts?.limit ?? 100) as SourceRevisionRow[]).map(
        rowToSourceRevision,
      );
    },
    list(opts) {
      return (listStmt.all(opts?.limit ?? 100) as SourceRevisionRow[]).map(rowToSourceRevision);
    },
  };
}

// ---------- Append-only event log + live subscription ----------

export interface EventRow {
  seq: number;
  executionId: string | null;
  kind: string;
  payload: unknown;
  recordedAt: Iso;
}

export interface AppendEventInput {
  executionId?: string | null;
  kind: string;
  payload: unknown;
}

export interface ReadEventsQuery {
  sinceSeq?: number;
  executionId?: string;
  limit?: number;
}

export interface EventSubscription {
  close(): void;
}

export interface EventLog {
  append(input: AppendEventInput): EventRow;
  read(query?: ReadEventsQuery): EventRow[];
  subscribe(handler: (row: EventRow) => void): EventSubscription;
}

interface EventRowRaw {
  seq: number;
  execution_id: string | null;
  kind: string;
  payload_json: string;
  recorded_at: string;
}

function rowToEvent(row: EventRowRaw): EventRow {
  return {
    seq: row.seq,
    executionId: row.execution_id,
    kind: row.kind,
    payload: JSON.parse(row.payload_json),
    recordedAt: row.recorded_at,
  };
}

export function createEventLog(db: SqliteDb): EventLog {
  const insert = db.prepare(`
    INSERT INTO execution_event (execution_id, kind, payload_json, recorded_at)
    VALUES (@execution_id, @kind, @payload_json, @recorded_at)
  `);
  const getBySeq = db.prepare("SELECT * FROM execution_event WHERE seq = ?");
  const readSince = db.prepare(
    "SELECT * FROM execution_event WHERE seq > ? ORDER BY seq ASC LIMIT ?",
  );
  const readSinceForExec = db.prepare(
    "SELECT * FROM execution_event WHERE seq > ? AND execution_id = ? ORDER BY seq ASC LIMIT ?",
  );

  const emitter = new EventEmitter();
  emitter.setMaxListeners(0);

  return {
    append(input) {
      const info = insert.run({
        execution_id: input.executionId ?? null,
        kind: input.kind,
        payload_json: JSON.stringify(input.payload ?? null),
        recorded_at: nowIso(),
      });
      const row = getBySeq.get(Number(info.lastInsertRowid)) as EventRowRaw;
      const event = rowToEvent(row);
      emitter.emit("event", event);
      return event;
    },
    read(query) {
      const since = query?.sinceSeq ?? 0;
      const limit = query?.limit ?? 500;
      const rows = query?.executionId
        ? (readSinceForExec.all(since, query.executionId, limit) as EventRowRaw[])
        : (readSince.all(since, limit) as EventRowRaw[]);
      return rows.map(rowToEvent);
    },
    subscribe(handler) {
      emitter.on("event", handler);
      return {
        close() {
          emitter.off("event", handler);
        },
      };
    },
  };
}
