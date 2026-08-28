# ADR-0003 — Complete V1 Architecture and Completion Contract

**Status:** Accepted<br>
**Date:** 2026-08-19<br>
**Implements:** [`../product/PRD.md`](../product/PRD.md)<br>
**Complements:** [ADR-0001 — Agent-Run MCP Trace Capture, Correlation, and Replay](./0001-agent-run-mcp-trace-capture-and-replay.md), [ADR-0002 — Modern MCP Trace Context and Local `stdio` Capture](./0002-modern-mcp-trace-context-and-local-stdio-capture.md)<br>
**Protocol target:** MCP `2026-07-28` modern era, with explicit supported legacy compatibility<br>
**Decision scope:** complete local-first V1 system architecture, persistence, process/trust boundaries, capability/execution model, protocol evidence, auth, source/trace intelligence, Agent Runs, Investigation Packets, packaging, conformance, migration, and release completion

---

## 1. Context

The repository has a real MCP execution foundation but not yet the complete product defined by the canonical PRD.

The current implementation already proves:

- a product-owned MCP adapter seam;
- official MCP V2 SDK integration;
- modern Streamable HTTP execution;
- `server/discover`, `tools/list`, and `tools/call`;
- concurrent calls and cancellation;
- partial/manual MRTR handling;
- Tasks extension advertisement/result detection;
- an explicit legacy adapter path;
- initial official conformance integration;
- a React/Vite web shell and Hono gateway;
- workspace presentation contracts;
- renderer, Investigation Packet, source-graph, and telemetry contracts;
- ADR-0001 Agent Run causal observability design;
- ADR-0002 W3C trace-context and local `stdio` capture design.

The canonical PRD now defines a much larger V1 completion contract: real external HTTP and local `stdio` server management; tools, resources, resource templates and prompts; complete MRTR and Tasks; persistent workspaces/history; protocol and transport evidence; auth; real Investigation Packets; Agent Run capture/views; configurable OpenTelemetry and revision-aware source intelligence; large-data handling; packaging; and explicit V1 release gates.

Incremental feature work must no longer discover architecture ad hoc. ADR-0003 resolves the architectural questions intentionally left open by PRD §44 and defines the target system to which implementation work must converge.

---

## 2. Decision summary

MCP Inspector X V1 SHALL use a **local-first control-plane architecture** with four primary runtime boundaries:

```text
Browser UI
   │
   │ same-origin HTTP / SSE
   ▼
Product Gateway / Control Plane
   │
   ├──────────────► Remote MCP servers (Streamable HTTP)
   │
   │ authenticated local IPC
   ▼
Privileged Local Runner
   ├──────────────► Local MCP servers (`stdio`)
   ├──────────────► Git/source repositories and source indexers
   ├──────────────► local secret providers / OS credential store
   └──────────────► privileged trace/source adapters

Durable local state
   ├── SQLite metadata + append-only domain/evidence events
   └── content-addressed artifact store for large/raw payloads
```

The browser SHALL NOT own MCP connections, credentials, durable evidence, local process spawning, source checkout, or authorization decisions.

The Product Gateway SHALL own user-facing domain APIs, safe remote MCP connections, scheduling/orchestration, durable projections, history, and live event delivery.

The Privileged Local Runner SHALL own process spawning/`stdio`, local filesystem/repository access, OS-level secret providers, and other privileged adapters. It SHALL be a separable process boundary from the gateway even in local V1.

The same domain/evidence model SHALL drive Graph, Grid, List, Timeline, Waterfall, history, focused inspection, source/runtime views, and Investigation Packets.

---

## 3. Decision drivers

This architecture is chosen to satisfy the following PRD constraints simultaneously:

- local-first complete V1 without requiring hosted infrastructure;
- multi-server and multi-capability workflows as the normal case;
- safe remote HTTP plus privileged local `stdio` support;
- future hosted/hybrid separation without redesigning the product domain model;
- exact protocol and transport evidence preservation;
- durable history and comparison;
- Agent Run ingestion from Inspector, gateway, `stdio`, runtime telemetry, and later adapters;
- revision-aware source intelligence without production-host filesystem dependence;
- backend-enforced credentials/redaction/authorization;
- graceful degradation when trace/source integrations are absent;
- deterministic Investigation Packets assembled from retained evidence;
- large payload/run scalability;
- explicit conformance claims rather than informal SDK-version claims.

---

## 4. Canonical V1 topology

### 4.1 Packaged local mode

The packaged local product SHALL run as:

```text
mcp-inspector-x
  supervisor
  ├── gateway/control-plane process
  ├── privileged runner process
  └── serves built web assets
```

The normal user entry point is one command/process supervisor. Internal process separation remains explicit.

Packaged default:

```text
Browser
  ↓ http://127.0.0.1:<ephemeral-or-configured-port>
Gateway
  ↓ local authenticated IPC
Runner
```

The gateway SHALL bind to loopback by default. Listening on non-loopback interfaces SHALL require explicit configuration and stronger authentication policy.

### 4.2 Development mode

Development may continue to run Vite and the gateway independently:

```text
Vite dev server
  ↓ proxy
Gateway
  ↓ IPC
Runner
```

Development topology is not the release topology and SHALL NOT be the only V1 smoke-test path.

### 4.3 Future hybrid/hosted mode

The architecture SHALL permit this later topology without changing domain contracts:

```text
Browser
  ↓
Hosted safe control plane
  ↓ remote MCP

Local runner
  ── outbound authenticated pairing ──► Hosted control plane
  ↓
local stdio / source / privileged telemetry
```

The hosted plane SHALL never expose arbitrary server-side process spawn as a generic user API.

---

## 5. Trust and process boundaries

### 5.1 Browser

The browser is presentation-only for security purposes.

It MAY hold ephemeral UI state but SHALL NOT be authoritative for:

- server credentials;
- OAuth tokens;
- local process permissions;
- source repository credentials;
- trace/source entitlements;
- redaction policy;
- execution authorization;
- historical evidence integrity.

### 5.2 Gateway / control plane

The gateway is the authoritative product API boundary.

It SHALL own:

- server catalog and safe connection state;
- capability catalog/projections;
- workspace CRUD;
- execution creation and scheduling;
- remote Streamable HTTP execution;
- MRTR/Task orchestration;
- history/comparison queries;
- Agent Run/Capture Session projections;
- Investigation Packet requests;
- persistence coordination;
- SSE live event delivery;
- backend authorization and redaction policy decisions.

### 5.3 Privileged runner

The runner SHALL own capabilities that require host privilege or local secrets:

- spawn/terminate local MCP processes;
- transparent `stdio` proxy mode;
- capture stdin/stdout/stderr/process evidence;
- local environment/working-directory policy;
- Git clone/fetch/index operations;
- private source access;
- OS credential-store operations;
- local-only trace/source backend credentials;
- optional sandbox/resource-limit enforcement.

### 5.4 Gateway ↔ runner IPC

V1 SHALL use authenticated local IPC. Preferred implementations:

- Unix domain socket on Unix-like systems;
- named pipe on Windows;
- loopback TCP only as a compatibility fallback.

The supervisor SHALL provision an ephemeral per-launch runner authentication secret/capability token. Runner APIs SHALL not trust loopback origin alone.

The runner protocol SHALL be versioned independently from browser APIs so a future packaged runner can pair with a hosted control plane.

---

## 6. Durable persistence topology

### 6.1 SQLite is the V1 canonical metadata store

V1 SHALL use SQLite for local durable metadata and normalized event/projection data.

SQLite is selected because V1 is local-first/single-operator, requires transactions and migrations, benefits from one portable state database, and does not require a network database service.

The database SHALL use WAL mode where supported and explicit schema migrations.

### 6.2 Artifact store

Large or raw payloads SHALL NOT be duplicated into ordinary relational rows.

V1 SHALL use a local content-addressed artifact store, conceptually:

```text
<data-dir>/
├── inspector.db
├── artifacts/
│   └── sha256/<prefix>/<digest>
├── git-cache/
└── indexes/
```

Artifacts MAY contain:

- large tool/resource results;
- bounded raw protocol transcripts;
- exported Investigation Packet attachments;
- trace payload batches;
- source-index artifacts;
- media/content blocks.

Database rows SHALL store `ArtifactRef` metadata including digest, MIME/content type, size, redaction/capture level, and creation/retention data.

### 6.3 No plaintext secret persistence

SQLite and artifact files SHALL NOT be the default secret store.

Secret-bearing fields are represented by `CredentialRef` / `SecretRef` identities. See §18.

### 6.4 Schema/version contract

The local database SHALL maintain:

- monotonically versioned schema migrations;
- an application data-model version;
- migration tests from every supported V1 persisted version;
- backup-before-destructive-migration behavior;
- failure that is explicit rather than silently rebuilding history.

### 6.5 Historical evidence immutability

Canonical historical execution/protocol events are append-only after durable commit. User labels/bookmarks/annotations MAY be mutable projections, but original evidence MUST NOT be rewritten to match current configuration.

---

## 7. Canonical domain model

The following product-owned entities are normative for V1 architecture. Exact TypeScript/SQL field names may vary, but ownership and relationships SHALL remain equivalent.

### 7.1 ServerDefinition

```text
ServerDefinition
├── id
├── displayName
├── transportPolicy
├── endpoint | stdioCommandRef
├── protocolPolicy
├── credentialRef?
├── sourceBindingIds[]
├── enabled
├── createdAt / updatedAt
└── configVersion
```

A ServerDefinition is durable configuration, not a live connection.

### 7.2 Connection

```text
Connection
├── id
├── serverId
├── transport
├── protocolEra
├── protocolVersion
├── negotiationEvidenceRef
├── state
├── openedAt
├── closedAt?
└── processId? / transportIdentity?
```

Connections are runtime state and may be persisted as historical evidence, but reconnecting creates a new connection identity.

### 7.3 CapabilityDefinition

```text
CapabilityDefinition
├── id
├── serverId
├── type
│   ├── tool
│   ├── resource
│   ├── resource_template
│   ├── prompt
│   └── extension
├── protocolIdentity
├── name / uri / template
├── title?
├── description?
├── schemas / annotations / rawMeta
├── discoverySnapshotId
└── availability
```

Stable capability identity is server-scoped and type-scoped. A tool name alone SHALL NOT be used as global identity.

### 7.4 Workspace / WorkspaceNode

```text
Workspace
├── id
├── name
├── revision
├── layout
├── filters/grouping
└── nodes[]

WorkspaceNode
├── id
├── capabilityId
├── presentation
├── selected
├── operationConfig
├── rendererPreference?
└── layoutPosition/group
```

Duplicate nodes referencing the same capability are permitted.

### 7.5 Execution

One `Execution` is one logical user/agent operation, even when it spans multiple MRTR rounds or a durable Task.

```text
Execution
├── id
├── capabilityId
├── serverId
├── connectionId?
├── workspaceNodeId?
├── agentRunId?
├── captureSessionId?
├── operationKind
├── status
├── startedAt / completedAt?
├── initialArguments/input
├── resultRef? / error?
├── protocolVersion
├── transport
├── sourceRevisionLinks[]
├── traceLinks[]
├── lineage
└── events[]
```

### 7.6 ExecutionRound

MRTR rounds are children of one Execution:

```text
ExecutionRound
├── executionId
├── round
├── requestId
├── requestStateRef?
├── inputRequests?
├── inputResponses?
├── requestEvidenceRef
├── responseEvidenceRef
└── outcome
```

`requestState` is opaque/untrusted protocol data and SHALL not be interpreted as product state.

### 7.7 TaskLifecycle

Task state is durable and attached to its originating Execution:

```text
TaskLifecycle
├── executionId
├── taskId
├── negotiatedExtensionVersion
├── currentState
├── transitions[]
├── nextPollAt?
└── terminalResultRef?
```

A Task may outlive the creating connection.

### 7.8 CaptureSession / AgentRun

ADR-0001/0002 remain authoritative. ADR-0003 fixes their storage relationship:

```text
CaptureSession
  observed evidence grouping when run identity is incomplete

AgentRun
  causal execution grouping only when reliable correlation exists
```

An Execution may first belong only to a CaptureSession and later receive a non-destructive correlation link to an AgentRun.

### 7.9 ProtocolEvidence / TransportEvent

Raw-ish bounded wire evidence and normalized product evidence are distinct:

```text
ProtocolEvidence
├── normalized method/capability/request/response facts
├── protocol era/version
├── extensions/capabilities
├── rawEnvelopeArtifactRef?
└── redactions[]

TransportEvent
├── transport
├── direction
├── timestamp
├── headers/message/process/log metadata
├── artifactRef?
└── redactions[]
```

### 7.10 SourceRevision / SourceGraph / TraceSpan

These remain separate domains linked by evidence IDs, not embedded copies inside Execution rows.

### 7.11 InvestigationPacket

A packet is a generated immutable artifact with its own manifest version and references to the evidence used to produce it.

---

## 8. Event model and live updates

### 8.1 Append-only aggregate events

Mutable execution state SHALL be derived from append-only product events.

Examples:

```text
execution.created
execution.started
protocol.request.observed
execution.input_required
execution.input_supplied
task.created
task.status_changed
transport.cancel_requested
execution.completed
execution.failed
trace.linked
source.revision_linked
agent_run.linked
```

Events SHALL carry:

- globally unique event ID;
- aggregate/entity ID;
- producer-local monotonic sequence;
- wall-clock timestamp;
- causal parent/link when known;
- evidence provenance;
- schema version.

### 8.2 No fabricated global order

The store SHALL preserve per-aggregate ordering and timestamps, not fabricate a universal serial order for concurrent operations.

### 8.3 Live browser event stream

The gateway SHALL expose a resumable Server-Sent Events stream for live product updates.

Rationale:

- product updates are predominantly server→browser;
- commands remain ordinary authenticated HTTP requests;
- SSE supports reconnection and event IDs;
- it avoids making core domain correctness depend on WebSocket session state.

The stream SHALL use event cursors/IDs so the browser can resume after a transient disconnect. Missing ranges can be reloaded through ordinary query APIs.

WebSocket MAY be added later for Apps or other bidirectional UI needs; it is not the V1 domain transport.

---

## 9. Product API boundary

### 9.1 Versioned API

The browser SHALL consume a versioned product API, initially `/api/v1/...`.

The existing ad-hoc demo routes are migration inputs, not the final contract.

### 9.2 Commands and queries

The API SHALL separate durable commands from read projections conceptually:

```text
Commands
  add/update/test server
  connect/disconnect
  create/update workspace
  execute/cancel/retry
  submit MRTR input
  update/cancel task
  generate packet
  start/stop capture

Queries
  servers/capabilities
  workspace projections
  execution/history/compare
  Agent Runs/Capture Sessions
  protocol/transport evidence
  trace/source views
  packet manifests
```

### 9.3 Browser never calls MCP server directly

All MCP operations SHALL flow through the gateway or runner so evidence, auth, cancellation, persistence, and correlation remain coherent.

---

## 10. MCP adapter architecture

### 10.1 Product-owned seam remains mandatory

`packages/protocol` remains the only product-facing MCP SDK seam.

Application packages SHALL NOT import official SDK internals directly except inside the protocol implementation package(s).

MCP Inspector upstream remains a reference/selective source, not a runtime dependency.

### 10.2 Expand from tool-only to capability-oriented adapter

The adapter SHALL evolve from current tool-centric methods to a capability-oriented interface supporting at least:

```text
connect / disconnect / discover
listTools / callTool
listResources / listResourceTemplates / readResource
listPrompts / getPrompt
subscription/listen support where negotiated
extension registry / Tasks lifecycle
protocol evidence hooks
```

The product domain SHALL not represent resources/prompts as fake tools.

### 10.3 Era policy

Every connection operation SHALL expose explicit policy:

```text
modern pinned
legacy pinned
compatible/auto
```

The selected exact protocol revision and era become durable evidence.

### 10.4 Modern semantics

For MCP `2026-07-28`, the adapter SHALL treat requests as stateless/self-contained and preserve the per-request metadata required by the specification.

The implementation SHALL not reconstruct a hidden protocol session model that modern MCP intentionally removed.

---

## 11. Protocol evidence capture architecture

### 11.1 Product-owned recording layer

MCP Inspector X SHALL implement a product-owned recording layer around the official SDK transport boundary rather than depend on unpublished Inspector internals.

Conceptually:

```text
Product execution
   ↓
Recording/Correlating adapter
   ↓
Official MCP SDK transport
   ↓
wire
```

The design MAY selectively port/reference the official Inspector's message-tracking approach, with attribution and pinned upstream revision, but the runtime abstraction remains owned by this repository.

### 11.2 HTTP capture

For Streamable HTTP, evidence SHALL include where available:

- method/URL;
- `MCP-Protocol-Version`;
- `Mcp-Method`;
- `Mcp-Name`;
- recognized `Mcp-Param-*` headers;
- authentication challenge metadata after redaction;
- request/response MCP envelopes;
- status/stream lifecycle;
- cache metadata;
- cancellation outcome;
- W3C trace metadata;
- timing.

Header/body mismatches and malformed protocol evidence SHALL be explicit failures, not normalized away.

### 11.3 `stdio` capture

The runner SHALL capture:

```text
client → server stdin   MCP messages
server → client stdout  MCP messages
server stderr           separate log events
process lifecycle       spawn/exit/signal
```

`stderr` MUST NOT be treated as an execution failure solely because data exists there.

Non-MCP output on stdout is a transport/protocol violation and SHALL be represented distinctly.

### 11.4 Evidence size policy

Normalized metadata may remain inline in SQLite. Raw/large envelopes and transcripts use ArtifactRefs.

Capture policy SHALL be applied before persistence.

---

## 12. Server lifecycle architecture

### 12.1 Durable configuration, ephemeral live connection

ServerDefinition persists; Connection is recreated as needed.

### 12.2 Remote HTTP

The gateway owns remote Streamable HTTP connections and OAuth/auth state.

Modern HTTP connections SHALL not be modeled as durable protocol sessions. The gateway may reuse SDK/client resources internally, but every request remains independently evidenced.

### 12.3 Local `stdio`

The runner owns process lifetime and connection identity.

The gateway requests runner operations through IPC; it SHALL NOT spawn processes directly.

### 12.4 Connection test

Connection-test results SHALL use a typed failure taxonomy and produce bounded evidence without creating ordinary workspace execution history unless the user opts to retain it.

### 12.5 Reconnect

Reconnect creates a new Connection identity. Existing ServerDefinition, capability history, workspaces, and prior executions remain intact.

---

## 13. Capability discovery architecture

### 13.1 Discovery snapshots

Each server refresh creates a `DiscoverySnapshot` containing:

- protocol/server identity;
- capability/extension inventory;
- pagination evidence;
- cache metadata;
- timestamp/connection identity.

Capabilities refer to the snapshot that produced them.

### 13.2 Pagination

The adapter SHALL follow pagination to produce complete catalog projections while retaining page/request evidence.

### 13.3 Change/listen behavior

Where modern `subscriptions/listen` or other negotiated change mechanisms are supported, updates create new discovery/change events. The product does not mutate historical capability definitions in place without provenance.

### 13.4 Cache behavior

Modern `ttlMs` and `cacheScope` metadata SHALL inform discovery caching but remain inspectable. `private` cache entries SHALL never be shared across future tenants/identities.

---

## 14. Workspace state architecture

### 14.1 Domain versus projection

Workspace node identity/configuration is durable domain state. Graph/Grid/List are projections.

Switching projection SHALL NOT create separate copies of node execution configuration.

### 14.2 Presentation state

`collapsed | expanded | focus` remains the canonical progressive-disclosure model.

Focus/fullscreen is a presentation projection; it does not create a new workspace node.

### 14.3 Operation configuration

Tool arguments, resource template variables, prompt arguments, renderer preference, and similar operation configuration are stored per WorkspaceNode.

A capability can have multiple nodes with independent configs.

### 14.4 Agent Run overlay

Observed nodes are read-only evidence overlays. Converting an observed execution into a planned/runnable node requires an explicit "copy into workspace" action.

---

## 15. Unified execution architecture

### 15.1 One execution service, typed operation kinds

Tools, resource reads, and prompt gets use one execution/history infrastructure but remain typed operations.

```text
Operation
├── tool.call
├── resource.read
├── prompt.get
└── extension/task operations
```

### 15.2 Scheduler

The gateway execution scheduler SHALL provide:

- bounded global concurrency;
- optional per-server limits;
- independent sibling failure isolation;
- cancellation tokens;
- queue/running/terminal states;
- no implicit Run All serialization.

### 15.3 Validation

Schema validation occurs before dispatch where possible. Validation errors are configuration errors, not MCP server failures.

### 15.4 Retry/rerun lineage

Every retry/rerun creates a new Execution with lineage metadata:

```text
rerunOf
retryOf
copiedFromHistoricalExecution
```

Past evidence remains immutable.

---

## 16. MRTR architecture

### 16.1 One logical execution across rounds

PRD MRTR-01..05 are implemented through ExecutionRound children.

### 16.2 Manual user-visible driver

For Inspector-interactive executions, the client SHALL use the official SDK's manual/inspectable `input_required` path rather than silently auto-fulfil inputs that should be visible to the operator.

The execution driver SHALL:

1. persist round request/response evidence;
2. transition Execution to `input_required` / `awaiting_input`;
3. expose the input request schema/content to the UI;
4. accept operator responses;
5. retry the same logical operation with byte-faithful protocol `requestState` handling through supported SDK APIs;
6. enforce a configurable maximum round count;
7. persist every round.

### 16.3 Agent/proxy behavior

When Inspector X is observing an external agent rather than controlling the call, it records the MRTR rounds it can observe and SHALL not intervene unless the proxy mode is explicitly configured to do so.

### 16.4 Legacy compatibility

The product SHALL rely on supported SDK legacy-shim behavior where appropriate rather than implement a parallel proprietary MRTR protocol.

---

## 17. Tasks extension architecture

### 17.1 Extension-driven plugin

Tasks live behind an extension registry. No Task UI/state is enabled unless the relevant extension is negotiated.

### 17.2 Durable task supervisor

A gateway `TaskSupervisor` SHALL own durable polling/update/cancel state independent of the originating request connection.

### 17.3 State machine

The extension wire statuses on a modern `2026-07-28` server are:

```text
working → input_required ↔ updated → completed | failed | cancelled
```

`created` MAY exist as an internal persistence state on the Inspector side — the moment the gateway has minted a durable Execution row but before the first observed `tasks/get`/`tools/call` result has classified the task. It MUST NOT be emitted as a task status on the wire, and MUST NOT be presented as a Tasks-extension status to users. UI classification of a Task presented as `created` MUST resolve to one of the wire statuses within one round of evidence, or fail loud.

Task transition events remain under the originating Execution.

### 17.4 Poll scheduling

Polling honors the `pollIntervalMs` (and, where present, `ttlMs`) carried on the Tasks-extension response envelope. Ownership of this behavior is on the product scheduler — SDK convenience for it is not required and not assumed. Browser refresh/restart SHALL NOT lose a retained active task; the supervisor resumes eligible polling from persisted state, re-reading `pollIntervalMs` from the last observed evidence.

### 17.5 Cancellation distinction

The product SHALL preserve distinct actions/evidence for:

- cancelling an active HTTP/stdio request;
- `tasks/cancel`;
- killing a local process.

---

## 18. Authentication and credential architecture

### 18.1 CredentialRef abstraction

Server/source/trace configurations reference credentials by ID.

```text
CredentialRef
├── id
├── provider
├── key/name
├── metadata safe for display
└── scope/binding metadata
```

Secret bytes SHALL not be returned to the browser.

### 18.2 V1 secret providers

V1 SHALL support at least:

1. environment-variable references;
2. OS credential-store/keychain-backed secrets through the runner;
3. in-memory/session-only credentials.

Plaintext durable secret values in workspace/server JSON are not a supported default.

If the OS credential store is unavailable, the product SHALL degrade to environment/session references rather than silently persist plaintext.

### 18.3 OAuth

Modern HTTP OAuth SHALL be implemented in the gateway/client auth layer and follow current MCP authorization requirements, including:

- protected resource metadata discovery;
- authorization-server discovery;
- `resource` parameter/audience binding;
- issuer binding/validation;
- separate registration/token state per authorization server;
- Client ID Metadata Documents where supported/preferred;
- DCR only as a compatibility path where needed;
- step-up/insufficient-scope recovery;
- mid-workflow reauthorization without losing unrelated workspace state.

### 18.4 `stdio` credentials

Core MCP HTTP OAuth is not applied to stdio. Local servers receive credentials through bounded runner environment/secret references according to operator policy.

### 18.5 Redaction

Redaction occurs before durable persistence/export. Logs, protocol envelopes, headers, baggage, URLs, args/results, and environment metadata all pass through a centralized redaction service.

---

## 19. Renderer architecture

### 19.1 Pure projection over immutable result data

Renderers SHALL not mutate execution evidence.

### 19.2 Renderer registry

A product-owned registry selects renderers by content/result characteristics.

Built-in V1 renderer families:

```text
json.formatted
json.tree
json.raw
table
TOON structured/table/raw
csv/tsv
ndjson
text
image/audio/media
resource/embedded-resource
binary/artifact metadata
```

### 19.3 Raw fallback

Raw view is always available subject to redaction/capture policy.

### 19.4 Failure isolation

Renderer failure creates renderer diagnostics and falls back to raw. It SHALL NOT change a successful MCP execution into `failed`.

### 19.5 Large data

Large results use:

- artifact-backed access;
- incremental parsing where feasible;
- row/tree virtualization;
- browser workers for expensive parsing/diffing where useful;
- pagination/windowing for tables and trees.

The UI SHALL not materialize entire large results into the DOM.

---

## 20. History and comparison architecture

### 20.1 History is execution-centric

Every retained tool call, resource read, prompt get, MRTR execution, and Task lifecycle is queryable through the same history domain with typed operation distinctions.

### 20.2 Comparison service

Comparison SHALL produce domain-specific diff sections:

```text
identity/revision
arguments/input
result/error
latency/status
protocol/transport
MRTR/Task lifecycle
trace
source
```

### 20.3 Previous-success baseline

The query layer SHALL support locating the nearest previous successful comparable Execution by stable capability identity and optional workspace/environment dimensions.

### 20.4 No implicit replay

History queries are observational. Re-execution requires an explicit command and produces new evidence.

---

## 21. Agent Run capture architecture

ADR-0001 and ADR-0002 are incorporated without replacement.

### 21.1 Observation adapters converge on the event model

```text
Inspector-controlled execution ──┐
HTTP gateway observation ────────┤
stdio proxy observation ─────────┤
OTel/runtime evidence ───────────┤──► correlation/link service ─► AgentRun projection
imported transcript ─────────────┘
```

### 21.2 Correlation links are first-class

Relationships SHALL be stored as link records with provenance, not by rewriting raw events.

```text
CorrelationLink
├── from
├── to
├── kind
├── provenance
│   ├── w3c_trace
│   ├── inspector_identity
│   ├── protocol_identity
│   ├── explicit_user_link
│   └── inferred
├── confidence/status
└── createdAt
```

### 21.3 Evidence precedence

Preferred correlation order remains:

1. W3C trace context;
2. explicit Inspector/agent run identity;
3. observed protocol identities/causal metadata;
4. explicit operator association;
5. inference.

Inference never overwrites stronger evidence.

### 21.4 Late correlation

A CaptureSession may later be linked to one or more Agent Runs as better evidence arrives. Historical raw evidence remains unchanged.

### 21.5 Views

Timeline, Waterfall, Graph, List, and Workspace overlay are query/projection layers over the same AgentRun/Execution/events.

---

## 22. OpenTelemetry trace architecture

### 22.1 Optional integration, real V1 surface

Trace configuration is optional, but the Trace surface is fully functional when configured and explicitly unavailable when not configured.

### 22.2 Initial V1 ingestion path

V1 SHALL define a `TraceProvider` interface and ship a local OTLP-compatible ingestion path through the control plane/runner boundary.

The initial implementation SHOULD accept OTLP/HTTP on an explicitly enabled loopback-only endpoint and normalize retained spans into product `TraceSpan` records/artifacts.

The architecture SHALL also permit external-backend resolvers that fetch traces by trace ID without forcing all trace data to be copied locally.

### 22.3 Correlation

Trace linkage uses trace/span IDs plus explicit execution metadata where available. Absence of trace data is valid and SHALL be represented as unavailable, not failure.

### 22.4 Storage

Normalized span index data may live in SQLite. Large/raw OTLP payloads use ArtifactRefs or remain external according to provider policy.

### 22.5 Authorization

Internal trace attributes and services may be more privileged than the visible MCP call. Backend authorization governs access and export.

---

## 23. Source intelligence architecture

### 23.1 Source bindings

A server may have one or more `SourceBinding` configurations:

```text
SourceBinding
├── serverId
├── repository identity/URL
├── credentialRef?
├── revision resolver strategy
├── indexer adapter
└── deployment mapping metadata
```

### 23.2 Git/revision cache

The runner owns a local Git object/cache area and SHALL fetch/index exact revisions without requiring access to production host filesystems.

Private repository credentials remain runner-side.

### 23.3 Revision resolution

Revision resolver evidence may come from:

- explicit server/deployment configuration;
- trace/resource attributes;
- build/deployment metadata;
- server-reported safe metadata;
- explicit operator mapping.

If exact revision is unresolved, source views SHALL state `unknown`. They SHALL NOT substitute repository default branch/main as execution truth.

### 23.4 Source graph

The source-index layer SHALL expose a language/indexer-neutral graph contract:

```text
SourceGraph
├── repositories/revisions
├── symbols
├── symbol ranges
├── static edges
├── capability entrypoint links
└── index provenance
```

Language/indexing adapters may evolve independently.

### 23.5 V1 indexing strategy

V1 SHALL prioritize useful bounded indexing for the languages actually supported by shipped adapters rather than claim universal language understanding.

Unsupported languages still support revision/file browsing when repository access exists, but static dependency/symbol features may be unavailable.

### 23.6 Code access API

Source data is served lazily through backend APIs:

```text
Relevant snippet
Full symbol
Full file
Dependencies
Dependents
Runtime trace links
```

Full files are never required to build the default execution view or default Investigation Packet.

### 23.7 Runtime overlay

Static edges and runtime-confirmed paths remain separate provenance classes. Runtime spans may highlight symbols/lines only where correlation evidence exists.

---

## 24. Investigation Packet assembly architecture

### 24.1 Packet builder is deterministic and versioned

```text
PacketManifest
├── schemaVersion
├── profile
├── generatedFrom evidence IDs
├── selection budgets
├── redaction policy/version
├── sections/artifact refs
└── missing/uncertain evidence
```

### 24.2 Profiles

V1 supports:

```text
Compact
Investigation (default)
Exhaustive
```

Each profile defines explicit evidence budgets rather than subjective ad hoc truncation.

### 24.3 Evidence-selection algorithm

Default `Investigation` selection SHALL include, subject to availability and redaction:

1. server/capability/protocol identity;
2. exact request arguments/input;
3. result/error and timing;
4. MRTR/Task lifecycle;
5. bounded protocol/transport excerpts directly tied to the execution;
6. directly correlated failing/slow runtime spans plus bounded parent/child context;
7. exact source revisions;
8. directly correlated source symbols/snippets;
9. bounded one-hop static context when useful and clearly labeled static;
10. optional comparison with previous successful execution;
11. explicit redaction/missing-evidence records;
12. concise investigation instructions.

### 24.4 No unbounded dump

Default profiles SHALL not dump full transcripts, full traces, full files, or repositories. Exhaustive may reference additional artifacts but remains bounded/configurable.

### 24.5 Generation after retention loss

If referenced evidence has expired, packet generation SHALL state the missing evidence rather than fabricate or silently re-execute.

---

## 25. Failure taxonomy

The product SHALL use typed failure domains rather than one generic `error`.

At minimum:

```text
configuration_error
validation_error
connection_error
authentication_error
authorization_error
protocol_negotiation_error
protocol_error
transport_error
tool_error
resource_error
prompt_error
mrtr_error
task_error
cancelled
timeout
process_spawn_error
process_exit_error
process_terminated
renderer_error
persistence_error
trace_unavailable | trace_error
source_unavailable | source_error
inspector_internal_error
```

An execution can be successful while renderer/source/trace enrichment fails. Derived/enrichment failures SHALL remain separate from core MCP outcome.

---

## 26. Security architecture

### 26.1 Central policy service

Authorization, capture level, redaction, and privilege checks SHALL be backend/runner services, not UI conditionals.

### 26.2 Untrusted inputs

The following are untrusted:

- server schemas/descriptions/annotations;
- MCP metadata/baggage;
- results/content blocks;
- stderr/logs;
- source content;
- remote App/UI content;
- OAuth metadata/endpoints.

They must be rendered/processed with appropriate validation/sandboxing.

### 26.3 Tool invocation consent

V1 SHALL expose enough capability/argument information for users to understand what will be invoked. Sensitive/destructive tool policy hooks MAY require explicit confirmation before execution.

### 26.4 Process policy

Runner stdio configuration supports policy controls for:

- executable/command allow/deny/confirmation;
- cwd restrictions;
- bounded environment inheritance;
- time/resource limits;
- process termination;
- optional sandbox adapters.

### 26.5 Browser/UI injection

Raw HTML from MCP results/Apps SHALL not be injected into the Inspector DOM. MCP Apps later use their specified sandbox/permission model.

---

## 27. Apps/extensions boundary

### 27.1 Generic extension registry now

V1 capability/server models SHALL retain extension IDs/versions/capabilities generically. Tasks is implemented as the first deep extension integration.

### 27.2 Apps compatibility

MCP App/UI metadata is inspectable in V1 even if full app hosting is post-V1.

### 27.3 Future Apps host

A future App host SHALL run in a dedicated sandboxed frame/host boundary with explicit permissions and SHALL route App-originated MCP operations back through the same gateway execution/evidence/authorization path.

Apps SHALL not receive direct privileged runner access.

---

## 28. Packaging and local data layout

### 28.1 Distribution goal

V1 SHALL ship a documented installable/runnable package that does not require manually launching two source-tree dev servers.

Exact distribution artifacts may include npm/package-manager and native wrappers, but the normative behavior is one operator command that starts the supervisor and opens/serves the dashboard.

### 28.2 Data directory

The data directory SHALL be explicit and overrideable. It contains no plaintext secrets by default.

### 28.3 Port behavior

Gateway should select a safe loopback port with configurable override. Packaged mode serves the web app same-origin to simplify browser security and API auth.

### 28.4 Local API authentication

Packaged local UI/API SHALL use a per-install/per-launch local authorization mechanism rather than assuming every local browser/tab is trusted. The supervisor may issue an ephemeral browser session token/cookie after controlled launch.

---

## 29. Conformance and protocol-support architecture

### 29.1 Support matrix is a versioned repository artifact

The repository SHALL maintain a machine-readable support matrix, e.g.:

```text
conformance/support-matrix.yml
```

It maps:

- protocol revision/era;
- transport;
- capability/extension;
- implementation status;
- integration tests;
- official conformance scenario(s);
- known expected failures/upstream blockers;
- claim status (`unsupported`, `experimental`, `supported`, `conformant`).

### 29.2 Pin conformance tool revision/version

Release evidence SHALL record the exact `@modelcontextprotocol/conformance` version/commit used.

### 29.3 Expected failures are durable and justified

Expected-failure baselines MUST include a reason and, where applicable, upstream issue reference. They cannot silently grow.

### 29.4 Current upstream caveat

As verified against `@modelcontextprotocol/conformance@0.2.0-alpha.11` (upstream `74edef3`, 2026-08-17) in the R-researcher memo dated 2026-08-28, the official conformance project has multiple open issues affecting final `2026-07-28` scoring, schema validation and coverage. Currently tracked at minimum:

- #426 — final `2026-07-28` still treated as draft; default Tier runs can score the wrong profile.
- #425 — earlier scored-profile drift referenced in prior baselines.
- #424 — core wire-schema validation rejects valid extension `resultType: "task"` envelopes.
- #422 — pre-registration fixture omits issuer context required by final authorization-server binding.
- #418 — raw HTTP / inline mocks bypass wire-schema instrumentation (unobserved raw traffic).
- #439, #440 — MRTR scenario / fixture defects.
- #461 — bundled everything-server can omit `resultType` on streamed tool responses.

Pin the exact harness and SDK commits per V1 evidence. V1 automation SHALL distinguish:

```text
our implementation failure
upstream conformance harness limitation
scenario not yet available
scenario explicitly unsupported
```

The absence of an official scenario does not waive our own deterministic integration tests.

### 29.5 Claim language

`ready`, `supported`, and `conformant` SHALL have separate machine-readable meanings. Unqualified whole-product conformance claims are forbidden unless the matrix genuinely supports them.

---

## 30. Current contract migration

### 30.1 Preserve useful seams

The following current foundations SHOULD be evolved rather than discarded:

- `McpClientAdapter` ownership boundary;
- composite capability identity principle;
- execution-state contracts;
- workspace `collapsed | expanded | focus` model;
- renderer classification concept;
- Investigation Packet deterministic/redaction concept;
- source graph/telemetry correlation seams;
- existing CI/security/promotion policy.

### 30.2 Replace demo-specific runtime assumptions

The following are transitional and SHALL not become permanent architecture:

- gateway boot hard-wired to the built-in demo server;
- static in-memory server binding array as the server catalog;
- tool-only web card model;
- UI buttons/tabs that claim behavior without wired evidence;
- synthetic `ExecutionRecord` creation in render-time UI code;
- non-persistent workspace/history state;
- generic `protocol evidence attached` labels without concrete evidence.

### 30.3 Expand adapter contract deliberately

If supporting resources/prompts/MRTR/Tasks/evidence requires breaking the current adapter contract, introduce a versioned contract migration rather than layer optional hacks onto a tool-only interface.

### 30.4 Data migration begins when persistence lands

Before V1, every stored schema change requires migration tests. Prior to the first persisted public/dev schema, destructive refactors are allowed but must not be misrepresented as stable migration guarantees.

---

## 31. Module/package target ownership

Exact package names may evolve, but responsibilities SHALL converge approximately to:

```text
apps/
├── web/                 presentation only
├── gateway/             product API/control plane
├── runner/              privileged local runtime
└── conformance-client/  protocol conformance harness

packages/
├── domain/              canonical entities/events/IDs
├── protocol/            official SDK adapter + protocol codecs/evidence
├── registry/            server/capability discovery projections
├── execution/           scheduler/MRTR/Tasks/cancellation
├── workspace/           durable workspace domain/projections
├── persistence/         SQLite repositories/migrations/artifact refs
├── artifacts/           content-addressed artifact store
├── auth/                credential refs/OAuth/redaction policy interfaces
├── renderers/           renderer registry/classifiers
├── agent-runs/          capture/correlation/projections
├── telemetry/           TraceProvider/span correlation
├── source-intelligence/ source bindings/index/query
├── investigation/       packet manifests/selection/builders
└── ui/                  reusable visual primitives
```

This is an ownership map, not a command to split every module immediately. Avoid circular dependencies; `domain` and stable product contracts sit below infrastructure implementations.

---

## 32. Dependency direction

The intended dependency direction is:

```text
Web UI
  ↓ product API types
Gateway/application services
  ↓
Domain contracts
  ↑                    ↑
Persistence        Infrastructure adapters
                   ├── protocol/SDK
                   ├── runner IPC
                   ├── auth providers
                   ├── trace providers
                   └── source indexers
```

Infrastructure SHALL depend on domain contracts; domain contracts SHALL not depend on Hono, React, SQLite drivers, MCP Inspector upstream code, or concrete trace/source backends.

---

## 33. Complete V1 implementation ledger

This ledger reconciles the canonical PRD with the current foundation and defines the target completion outcome. It is architecture-level status, not a substitute for a detailed implementation issue/Beads ledger.

| PRD area | Current baseline | ADR-0003 V1 outcome | Product milestone |
|---|---|---|---|
| SRV-01..10 | demo HTTP binding; no durable catalog/stdio runner | persistent ServerDefinition + connection test + remote HTTP + runner-owned stdio | M1 |
| CAP-01..09 | real tools discovery only | paginated multi-type capability catalog/snapshots | M1 |
| TOOL-01..12 | protocol call works; UI config/run incomplete | schema forms + raw mode + One/Selected/All + typed errors/history | M1 |
| RES-01..06 | missing | real list/template/read/history/render workflow | M1 |
| PRM-01..05 | missing | real list/get/args/history workflow | M1 |
| MRTR-01..05 | detection/manual partial | persisted multi-round driver with operator input | M2 |
| TASK-01..07 | advertise/detect partial | durable negotiated TaskSupervisor lifecycle | M2 |
| APP-01..04 | mostly absent | generic extension/App metadata compatible; full sandbox host post-V1 allowed | M2/post-V1 |
| WS-01..09 | in-memory shell | durable workspaces + shared Graph/Grid/List projections | M1 |
| INSPECT-01..03 | shell tabs | evidence-driven tabs/focus/cross-navigation | M1/M3 |
| RENDER-01..08 | classification foundation | registry + raw/JSON/table/TOON/text/media + large-data handling | M1 |
| HIST-01..06 | missing | SQLite-backed immutable history/compare/rerun | M1 |
| PROTO-01..09 | partial normalized evidence | recording layer + raw bounded HTTP/stdio evidence | M1/M2 |
| AUTH-01..07 | missing/incomplete | CredentialRef providers + modern OAuth + central redaction | M2 |
| STDIO-01..07 | ADR only | separate runner + inspector-originated stdio + transparent proxy | M1/M4 |
| AGENT-01..10 | ADR only | event/correlation model + live/historical views | M4 |
| TRACE-01..06 | contract only | TraceProvider + OTLP/local ingestion + correlation | M3 |
| SRC-01..09 | contract only | revision-aware runner index + lazy code APIs | M3 |
| PACKET-01..10 | builder contract/foundation | real evidence-backed versioned packet pipeline | M3/M4 |
| DATA-01..06 | missing | SQLite + artifact store + migrations/retention | M1 |
| SEC-01..07 | CI baseline + conceptual planes | enforce gateway/runner/secret/capture policies | all |
| UX-01..07 | early shell | professional evidence-driven production UX | M1–M5 |
| NFR-01..09 | partial tests | backpressure/virtualization/offline history/version provenance | M5 |

---

## 34. Required implementation order

Architecture permits parallel work, but dependencies imply this critical path:

```text
A. domain IDs/events + persistence/artifacts
   ↓
B. gateway API + runner IPC + secret refs
   ↓
C. durable server catalog + HTTP/stdio connection lifecycle
   ↓
D. full capability adapter + discovery catalog
   ↓
E. workspace persistence + schema forms + execution scheduler
   ↓
F. resources/prompts + protocol evidence + history/renderers
   ↓
G. complete MRTR + Tasks + OAuth + conformance matrix
   ↓
H. real Investigation Packets + source + trace
   ↓
I. AgentRun/capture/stdio-proxy views
   ↓
J. packaging/performance/security/release hardening
```

Source/trace indexer work may run in parallel after stable Execution/evidence IDs exist. Agent Run UI may begin after event IDs/correlation contracts exist, but final integration waits on real capture seams.

---

## 35. Stop conditions

Implementation SHALL stop and propose an ADR amendment rather than paper over evidence if any of these occur:

- official MCP SDK cannot expose/carry required protocol semantics through the product-owned adapter safely;
- MRTR or Tasks require a fundamentally different durable execution identity model;
- stdio proxying cannot remain transparent with required tracing behavior;
- browser/gateway/runner separation makes a required local feature impossible without new privilege flow;
- SQLite/artifact topology cannot meet measured V1 workload/retention requirements;
- current MCP authorization requirements conflict with the chosen credential abstraction;
- exact revision/source evidence cannot be represented without fabricating certainty;
- official conformance requirements contradict an accepted protocol assumption.

Convenience alone is not an architectural stop condition.

---

## 36. V1 completion contract

V1 SHALL NOT be declared complete merely because underlying protocol functions exist.

All PRD §36 end-to-end scenarios A–H MUST pass against real MCP servers and packaged product mode.

At release-candidate time the repository SHALL contain a completion ledger with, for every stable PRD requirement ID:

```text
requirement
status: satisfied | deferred-by-PRD | unsupported-with-approved-amendment
implementation references
verification/test evidence
release/conformance evidence where applicable
```

No `partial` requirement may be counted as V1 complete.

### 36.1 Mandatory product acceptance

A V1 candidate must demonstrate, in packaged local mode:

1. add/save/test one real remote Streamable HTTP server;
2. add/save/launch one real local stdio server;
3. discover tools/resources/prompts across multiple servers;
4. persist a workspace with duplicate independently configured capability nodes;
5. execute One/Selected/All with bounded concurrency and independent failures;
6. complete a real MRTR flow under one Execution;
7. complete/cancel/update a real negotiated Task lifecycle;
8. authenticate to a supported remote OAuth-protected MCP server through the modern auth model;
9. inspect immutable history and compare failure vs previous success;
10. inspect concrete protocol/transport evidence;
11. generate a real deterministic redacted Investigation Packet;
12. observe external local MCP calls through `stdio-proxy` under CaptureSession/AgentRun;
13. inspect Agent Run Timeline/Waterfall/Graph/List/Workspace projections;
14. when configured, correlate an execution to trace spans and exact source revision/symbols;
15. when trace/source is not configured, show explicit unavailable states without fake data;
16. reload/restart and retain catalog/workspace/history according to retention policy;
17. process large results/history without unbounded DOM/memory behavior;
18. pass documented release/conformance/security gates.

### 36.2 No placeholder completion

A tab/button may exist early, but V1 release evidence cannot claim a requirement satisfied while the control is a no-op, fixture-only path, synthetic record, or static placeholder.

---

## 37. Conformance/release gates

In addition to PRD §37:

- typecheck/test/build MUST pass;
- security scans MUST pass or carry explicit durable waiver;
- database migration tests MUST pass;
- runner IPC/auth tests MUST pass;
- redaction/secret-leak tests MUST pass;
- remote HTTP and stdio real integration suites MUST pass;
- resource/prompt integration tests MUST pass;
- MRTR/Tasks integration tests MUST pass;
- AgentRun correlation/provenance tests MUST pass;
- large-result and 1,000-row/run virtualization validation MUST pass;
- packaged smoke test MUST pass from a clean state;
- support matrix and conformance evidence MUST be regenerated and committed/published with the release evidence.

---

## 38. Consequences

### Positive

- One coherent architecture now covers the entire PRD instead of accumulating isolated feature decisions.
- Browser/UI code remains replaceable and unprivileged.
- Local stdio/source power is structurally isolated from future hosted safe execution.
- SQLite + artifact storage gives V1 durable local history without requiring infrastructure services.
- Append-only event/evidence semantics support history, Agent Runs, MRTR, Tasks, and late correlation cleanly.
- Resources/prompts become first-class without rewriting execution/history architecture.
- Protocol evidence remains independent of renderer/UI normalization.
- Source/trace integrations can be optional yet real.
- Future hosted/hybrid pairing can reuse the same runner and product domain boundaries.
- V1 completion becomes objectively auditable against stable PRD requirement IDs.

### Negative / cost

- A separate runner process and IPC add implementation complexity compared with one all-powerful local server.
- SQLite migrations and artifact lifecycle become permanent product responsibilities.
- Append-only evidence requires projection/query discipline rather than mutable in-memory state shortcuts.
- OAuth/secret-provider correctness is substantial work.
- Full capability coverage plus MRTR/Tasks expands V1 beyond a tool-only inspector.
- Source and trace integration still require language/backend adapters and cannot be universally complete in V1.
- Packaging must supervise multiple internal processes reliably.

These costs are accepted because they remove larger future security and architecture rewrites.

---

## 39. Rejected alternatives

### 39.1 Browser directly connects to MCP servers

Rejected. It fragments auth/evidence, cannot safely spawn stdio, weakens persistence/correlation, and makes future hosted/local privilege separation harder.

### 39.2 One monolithic gateway process with arbitrary local privileges

Rejected as the canonical architecture. It makes future hosted deployment unsafe and blurs remote-safe APIs with local process/source privilege. A packaged supervisor may make the two processes feel like one product, but the privilege boundary remains real.

### 39.3 Electron-only architecture

Rejected as a core requirement. A desktop shell may be added later, but the product domain/control plane must remain usable through a browser/local service and not depend on Electron IPC semantics.

### 39.4 Hosted-first database/service architecture

Rejected for V1. PostgreSQL/object storage/team identity would add operational complexity before the local workbench is complete.

### 39.5 Store everything in JSON files

Rejected. Durable history, migrations, concurrent updates, filtering/comparison, and event correlation require transactional/queryable metadata.

### 39.6 Store every payload directly in SQLite

Rejected. Large binary/results/transcripts/source artifacts would bloat the database and make retention/export inefficient.

### 39.7 Reuse official Inspector internals as runtime core

Rejected. Official Inspector remains an important reference, but unpublished/internal package structure is not our stable product contract.

### 39.8 Tool-only V1

Rejected by the canonical PRD. Tools are the deepest first workflow, but complete V1 includes resources/resource templates and prompts as real capability types.

### 39.9 Make tracing/source mandatory for execution

Rejected. Basic MCP operation remains valid without telemetry/source configuration. Diagnostic intelligence degrades explicitly.

### 39.10 Infer deployed source from repository default branch

Rejected. This would create false diagnostic evidence.

### 39.11 Treat stdio connection lifetime as Agent Run lifetime

Rejected by ADR-0001/0002. Long-lived processes can serve multiple unrelated agent runs.

### 39.12 Flat request log instead of event/causal model

Rejected. It cannot represent concurrency, MRTR, Tasks, Agent Runs, or late trace/source correlation correctly.

---

## 40. Verification against MCP `2026-07-28`

This ADR was reconciled on 2026-08-19 against current primary MCP sources.

Key architectural facts used by this decision:

- `2026-07-28` is the current formal latest protocol revision in the specification schema.
- The core is stateless/self-contained per request with per-request metadata/capability semantics.
- Standard transport semantics remain transport bindings; protocol semantics are not defined by HTTP vs stdio.
- Modern Streamable HTTP uses routing/version headers including `Mcp-Method`, `Mcp-Name`, and schema-driven `Mcp-Param-*` where applicable.
- `input_required` applies to `tools/call`, `prompts/get`, and `resources/read`; the official TypeScript SDK supports explicit/manual and automatic fulfilment modes.
- Tasks moved to the optional `io.modelcontextprotocol/tasks` extension and use durable task operations rather than being assumed core behavior.
- Modern authorization is HTTP-oriented; stdio should obtain credentials from the local environment/host mechanism instead of applying HTTP OAuth.
- Modern authorization requires protected-resource discovery/audience binding and authorization-server/issuer-aware credential isolation.
- W3C trace context is first-class evidence for correlation where present.
- Official conformance is evolving and must be pinned/scoped rather than treated as an infallible whole-product oracle.

Primary references:

- MCP specification `2026-07-28`: https://github.com/modelcontextprotocol/modelcontextprotocol/tree/main/docs/specification/2026-07-28
- final schema: https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/schema/2026-07-28/schema.ts
- TypeScript SDK V2 `2026-07-28` migration/support guide: https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/support-2026-07-28.md
- official Inspector V2 spec-impact analysis: https://github.com/modelcontextprotocol/inspector/blob/main/specification/v2_new_spec_impact.md
- official conformance project: https://github.com/modelcontextprotocol/conformance

Implementation agents MUST re-verify exact SDK APIs and conformance behavior against current primary sources before coding protocol-sensitive slices; this ADR fixes product architecture, not remembered function names.

---

## 41. Final decision

Proceed with the architecture defined in ADR-0003 as the canonical complete V1 target.

The durable shape is:

```text
Browser UI
   ↓
Gateway / Product API
   ├── server + capability registry
   ├── workspace + execution scheduler
   ├── MRTR + Task supervisors
   ├── history/comparison
   ├── AgentRun/correlation
   └── Investigation Packet orchestration
   │
   ├──────────────► Remote Streamable HTTP MCP
   │
   ↓ authenticated local IPC
Privileged Runner
   ├──────────────► Local stdio MCP
   ├──────────────► Git/source indexes
   ├──────────────► OS secret providers
   └──────────────► privileged trace/source adapters

SQLite metadata/events
      +
content-addressed artifacts
      ↓
shared evidence model
      ↓
Graph / Grid / List / Timeline / Waterfall / Source / Trace / Packets
```

Future implementation work SHALL be reconciled against the PRD requirement IDs and this architecture. Any material deviation requires an explicit PRD/ADR amendment rather than silent drift.
