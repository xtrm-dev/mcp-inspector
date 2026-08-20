export {
  openDatabase,
  applyMigrations,
  closeDatabase,
  type SqliteDb,
  type OpenDbOptions,
  type MigrationReport,
} from "./database";

export { MIGRATIONS, checksum, type Migration, type AppliedMigration } from "./migrations";

export {
  createArtifactStore,
  type ArtifactStore,
  type ArtifactRecord,
  type ArtifactStoreOptions,
  type PutArtifactInput,
} from "./artifacts";

export {
  createServerRepository,
  createCredentialRefRepository,
  createWorkspaceRepository,
  createWorkspaceNodeRepository,
  createExecutionRepository,
  createExecutionRoundRepository,
  createEvidenceRepository,
  createCaptureSessionRepository,
  createAgentRunRepository,
  createTraceRepository,
  createSourceRevisionRepository,
  createEventLog,
  type ServerRepository,
  type ServerDefinition,
  type UpsertServerInput,
  type Transport,
  type ProtocolPolicy,
  type CredentialRefRepository,
  type CredentialRef,
  type CreateCredentialRefInput,
  type CredentialProvider,
  type WorkspaceRepository,
  type Workspace,
  type CreateWorkspaceInput,
  type UpdateWorkspaceInput,
  type WorkspaceNodeRepository,
  type WorkspaceNode,
  type CreateWorkspaceNodeInput,
  type UpdateWorkspaceNodeInput,
  type WorkspaceNodePresentation,
  type ExecutionRepository,
  type ExecutionRecord,
  type CreateExecutionInput,
  type ExecutionRoundRepository,
  type ExecutionRound,
  type AppendRoundInput,
  type RoundKind,
  type EvidenceRepository,
  type EvidenceRef,
  type AppendEvidenceInput,
  type EvidenceKind,
  type CaptureSessionRepository,
  type CaptureSession,
  type CreateCaptureSessionInput,
  type CaptureKind,
  type AgentRunRepository,
  type AgentRun,
  type CreateAgentRunInput,
  type CorrelationKind,
  type TraceRepository,
  type TraceRecord,
  type PutTraceInput,
  type SourceRevisionRepository,
  type SourceRevision,
  type RegisterSourceRevisionInput,
  type EventLog,
  type EventRow,
  type AppendEventInput,
  type ReadEventsQuery,
  type EventSubscription,
} from "./repositories";

import { openDatabase, applyMigrations, type SqliteDb } from "./database";
import { createArtifactStore, type ArtifactStore } from "./artifacts";
import {
  createServerRepository,
  createCredentialRefRepository,
  createWorkspaceRepository,
  createWorkspaceNodeRepository,
  createExecutionRepository,
  createExecutionRoundRepository,
  createEvidenceRepository,
  createCaptureSessionRepository,
  createAgentRunRepository,
  createTraceRepository,
  createSourceRevisionRepository,
  createEventLog,
  type ServerRepository,
  type CredentialRefRepository,
  type WorkspaceRepository,
  type WorkspaceNodeRepository,
  type ExecutionRepository,
  type ExecutionRoundRepository,
  type EvidenceRepository,
  type CaptureSessionRepository,
  type AgentRunRepository,
  type TraceRepository,
  type SourceRevisionRepository,
  type EventLog,
} from "./repositories";
import { join } from "node:path";

export interface StorageOptions {
  dataDir: string;
}

export interface Storage {
  db: SqliteDb;
  artifacts: ArtifactStore;
  servers: ServerRepository;
  credentials: CredentialRefRepository;
  workspaces: WorkspaceRepository;
  workspaceNodes: WorkspaceNodeRepository;
  executions: ExecutionRepository;
  rounds: ExecutionRoundRepository;
  evidence: EvidenceRepository;
  captureSessions: CaptureSessionRepository;
  agentRuns: AgentRunRepository;
  traces: TraceRepository;
  sourceRevisions: SourceRevisionRepository;
  events: EventLog;
  close(): void;
}

/**
 * Open the durable substrate: SQLite + artifact store + repositories + event log.
 * `dataDir` owns `state.sqlite3` and `artifacts/`.
 */
export function openStorage(options: StorageOptions): Storage {
  const db = openDatabase({ path: join(options.dataDir, "state.sqlite3") });
  applyMigrations(db);
  const artifacts = createArtifactStore({ db, root: join(options.dataDir, "artifacts") });
  return {
    db,
    artifacts,
    servers: createServerRepository(db),
    credentials: createCredentialRefRepository(db),
    workspaces: createWorkspaceRepository(db),
    workspaceNodes: createWorkspaceNodeRepository(db),
    executions: createExecutionRepository(db),
    rounds: createExecutionRoundRepository(db),
    evidence: createEvidenceRepository(db),
    captureSessions: createCaptureSessionRepository(db),
    agentRuns: createAgentRunRepository(db),
    traces: createTraceRepository(db),
    sourceRevisions: createSourceRevisionRepository(db),
    events: createEventLog(db),
    close() {
      db.close();
    },
  };
}
