# ADR-0001 — Agent-Run MCP Trace Capture, Correlation, and Replay

**Status:** Accepted  
**Date:** 2026-08-17  
**Decision scope:** MCP Inspector X runtime observability, workspace visualization, source intelligence, and diagnostic handoff  
**Protocol target:** MCP `2026-07-28` modern era, with explicit legacy compatibility where supported

## 1. Context

MCP Inspector X already models MCP execution, protocol evidence, OpenTelemetry-style spans, revision-aware source graphs, and Investigation Packets. The next requirement is to inspect MCP calls that originate outside the Inspector itself, especially calls made by an agent, CLI, application, or another MCP-capable runtime.

The operator should be able to open MCP Inspector X after or during an agent run and answer:

- Which MCP tools did this run call?
- In what causal order did those calls occur?
- Which calls ran concurrently?
- What arguments and results were observed?
- Which call failed, timed out, required input, or created a task?
- Which MCP server and protocol version handled each call?
- Which downstream spans executed?
- Which source symbols and deployed revisions correspond to those spans?
- Can one call, several calls, or the complete agent run be copied into an Investigation Packet?

A flat request log is insufficient. Agent execution is concurrent, nested, multi-round-trip, and potentially task-backed. The product therefore needs a causal execution model rather than a synthetic serial list.

## 2. Decision

MCP Inspector X SHALL introduce a first-class **Agent Run Trace** model.

An Agent Run Trace groups MCP interactions, runtime spans, source correlation, and execution evidence under one logical run identity regardless of whether the run originated from MCP Inspector X.

```text
AgentRun
  ↓
MCP logical calls
  ↓
MCP protocol rounds / task transitions
  ↓
server/runtime spans
  ↓
source symbols / deployed revision
```

The same persisted trace data SHALL drive multiple interchangeable UI projections:

```text
AgentRun
├── Timeline
├── Waterfall
├── Graph
├── List
└── Workspace overlay
```

No view owns the data. Views are projections of the same causal event model.

## 3. Observation model

MCP Inspector X can only reconstruct behavior that passes through at least one trusted observation point.

Supported observation sources SHALL be:

```text
client instrumentation
OR
gateway/proxy instrumentation
OR
server instrumentation
OR
imported OpenTelemetry-compatible trace data
```

### 3.1 Instrumented client

Preferred when MCP Inspector X controls or integrates with the MCP client runtime.

```text
Agent
  ↓
instrumented MCP client
  ↓
MCP server
```

This provides the richest evidence because the Inspector can identify the originating run before the request leaves the client.

### 3.2 Inspector gateway / proxy

Preferred for generic agents or applications that can route MCP traffic through MCP Inspector X.

```text
Agent / CLI / application
          ↓
MCP Inspector X Gateway
          ↓
MCP server
```

This mode can capture protocol-visible requests and responses without requiring the originating runtime to understand the Inspector data model.

### 3.3 Server-only instrumentation

When an external client talks directly to an instrumented server, MCP Inspector X can observe the server-side call and downstream trace but may not know the complete upstream agent run.

```text
external client
      ↓
instrumented MCP server
      ↓
service / database / API
```

The run origin MAY be recorded as `unknown` or inferred only when reliable propagated trace/run metadata exists.

### 3.4 No observation point

MCP Inspector X MUST NOT claim to reconstruct traffic when neither client, gateway, nor server emitted observable evidence.

```text
uninstrumented client
      ↓
uninstrumented server

=> no reliable trace
```

Partial observability SHALL be represented explicitly rather than silently filled with inferred events.

## 4. Causal ordering

The Inspector MUST NOT invent a total serial order for concurrent operations.

Each event SHALL preserve:

- wall-clock start/end timestamps;
- parent/child relationship where known;
- trace/span identity where known;
- a logical MCP call identity;
- an optional producer-local sequence number;
- concurrency implied by overlapping intervals and shared parents.

Example:

```text
Agent run
│
├─ futures_prices      184 ms ──────┐
├─ treasury_curve      312 ms ──────┤ concurrent siblings
└─ latest_releases     488 ms ──────┘
          ↓
   spread_analysis
```

The Timeline view MAY sort by timestamp for readability, but it MUST preserve causal metadata and MUST indicate overlapping calls.

## 5. Core data model

### 5.1 AgentRun

```text
AgentRun
├── id
├── origin
├── originInstance?
├── traceId?
├── parentRunId?
├── startedAt
├── completedAt?
├── status
├── workspaceId?
├── actorIdentity?
├── tenantId?
├── tags
└── events[]
```

`origin` SHOULD use a bounded vocabulary while permitting future extension:

```text
inspector
claude-code
pi
codex
cli
application
remote-agent
unknown
```

Origin is descriptive evidence, not an authorization mechanism.

### 5.2 McpCallEvent

```text
McpCallEvent
├── id
├── agentRunId?
├── logicalCallId
├── traceId?
├── spanId?
├── parentSpanId?
├── parentLogicalCallId?
├── sequence?
├── serverId
├── capabilityId
├── toolName
├── protocolEra
├── protocolVersion
├── startedAt
├── completedAt?
├── status
├── arguments
├── result?
├── error?
├── mrtrRounds[]
├── taskLifecycle?
├── protocolEvidence
├── sourceRevision?
└── redactions[]
```

The Inspector's stable composite capability identity SHALL remain authoritative. `toolName` alone is not globally unique.

### 5.3 MRTR evidence

All rounds belonging to one logical MCP call SHALL remain grouped.

```text
logicalCallId: call-17

round 1
  tools/call
  → input_required

round 2
  tools/call + inputResponses + requestState
  → complete
```

Timeline and Graph views MAY expose individual rounds, but the workspace SHOULD default to one logical tool-call node with expandable rounds.

### 5.4 Task lifecycle

Task-backed calls SHALL remain one logical call with an ordered lifecycle.

```text
tools/call
  ↓
task_created
  ↓
tasks/get
  ↓
tasks/get
  ↓
complete
```

Polling events MUST NOT appear as unrelated top-level tool invocations.

## 6. Trace context propagation

MCP Inspector X SHOULD use standard distributed tracing context wherever the participating client, transport, server, and telemetry stack support it.

The correlation layer SHALL preserve W3C/OpenTelemetry-compatible trace identifiers and MUST avoid inventing relationships when context is absent.

MCP-specific request metadata and transport evidence SHALL be stored separately from normalized trace spans so that protocol inspection remains possible even when full distributed tracing is unavailable.

Conceptually:

```text
Agent span
   ↓
MCP client span
   ↓
MCP logical call
   ↓
MCP server span
   ↓
service span
   ↓
database / API span
```

## 7. Runtime-to-source correlation

The existing `packages/telemetry` correlation seam SHALL be extended rather than replaced.

Current model:

```text
TraceSpan
├── traceId
├── spanId
├── parentSpanId
├── timing/status
└── sourceSymbolId?
```

Agent-run tracing SHALL add enough identity to associate spans with a run and logical MCP call while preserving the existing source-symbol correlation.

Target relationship:

```text
AgentRun
  ↓
McpCallEvent
  ↓
TraceSpan[]
  ↓
SourceGraph symbols
  ↓
exact deployed revision
```

Source relationships inferred statically MUST remain visually distinguishable from runtime-confirmed spans.

## 8. Workspace integration

Agent traces SHALL be inspectable inside the existing workspace rather than in a separate product surface.

### 8.1 Workspace overlay

The operator can add an Agent Run to a workspace and choose whether to show:

- all MCP calls;
- only failures;
- only selected servers/tools;
- only the critical path;
- one subtree of the causal graph.

Example:

```text
Workspace
├── manually configured tool nodes
└── Agent Run: Analyze US rates
    ├── futures_prices
    ├── treasury_curve
    ├── latest_releases
    └── spread_analysis
```

Manually configured workspace nodes and observed agent-run nodes SHOULD share the same result/source/trace presentation components where their evidence models overlap.

### 8.2 Expanded call card

Selecting an observed MCP call SHALL support the existing progressive inspection model:

```text
collapsed
  → tool + status + duration

expanded
  → arguments
  → result
  → protocol
  → trace
  → source
  → history
  → agent handoff

focus/fullscreen
  → large result/code/trace surface
```

Recommended local tabs:

```text
[Result] [Arguments] [Protocol] [Trace] [Source] [History]
```

## 9. Timeline view

Timeline SHALL provide a timestamp-oriented replay.

```text
09:41:12.004  agent started
09:41:12.441  futures_prices       START
09:41:12.449  treasury_curve       START
09:41:12.633  futures_prices       SUCCESS 192 ms
09:41:12.761  treasury_curve       SUCCESS 312 ms
09:41:13.021  latest_releases      START
09:41:15.024  latest_releases      TIMEOUT 2.00 s
09:41:15.031  agent completed
```

The UI MUST make concurrent overlap visible and MUST NOT imply that timestamp sorting alone represents dependency order.

## 10. Waterfall view

Waterfall SHALL optimize for latency and concurrency diagnosis.

```text
agent run            ├──────────────────────────────┤
futures_prices          ├──────┤
treasury_curve          ├───────────┤
latest_releases                    ├────────────────┤
spread_analysis                                   ├───┤
```

Waterfall SHOULD support:

- zoom;
- duration thresholds;
- error highlighting;
- critical-path estimation when dependencies are known;
- grouping by server, tool, agent step, or trace subtree.

## 11. Graph view

Graph SHALL optimize for causal structure.

```text
Agent run
  ├─ futures_prices ───┐
  ├─ treasury_curve ───┼─→ spread_analysis
  └─ latest_releases ──┘
```

Edges MUST carry provenance:

```text
runtime-confirmed
propagated trace parent
logical MCP relationship
static/inferred source relationship
```

The UI MUST distinguish these edge classes.

## 12. List view

List SHALL optimize for filtering and bulk action.

Example filters:

```text
server
capability/tool
status
origin
protocol era/version
duration
trace present
source correlation present
MRTR
Task-backed
error type
```

Bulk selection SHALL support:

- add selected calls to workspace;
- compare selected calls;
- export selected evidence;
- Copy Selected for Agent.

## 13. Investigation Packet integration

Any observed MCP call, selected set of calls, or complete Agent Run SHALL be exportable through the existing Investigation Packet system.

Agent-run packets SHOULD add:

```text
AgentRun context
├── origin
├── run identity
├── ordered/causal MCP calls
├── concurrency information
├── failing/slow calls
├── MRTR rounds
├── task lifecycle
├── runtime traces
├── source graph references
└── exact revisions where known
```

Secrets and sensitive payloads MUST follow the same explicit redaction policy as other Investigation Packets.

## 14. Security, tenancy, and privacy

Agent-run tracing can capture arguments, results, prompts, identifiers, and internal infrastructure metadata. It therefore requires a strict trust boundary.

### 14.1 Backend authorization

Trace access MUST be enforced by the backend.

The frontend MUST NOT be the authorization boundary.

### 14.2 Tenant isolation

Hosted/multi-tenant deployments MUST scope:

- AgentRun records;
- MCP call evidence;
- traces;
- result payloads;
- source access;
- Investigation Packets;
- cache keys.

### 14.3 Payload capture policy

Deployments SHALL be able to configure capture levels:

```text
metadata-only
arguments + metadata
results + metadata
full diagnostic
```

Sensitive headers, credentials, tokens, cookies, signed URLs, and configured secret fields MUST be redacted before persistence or export.

### 14.4 Privileged source plane

Capturing a user-visible MCP call MUST NOT automatically grant access to private source code, full internal traces, deployment metadata, or infrastructure topology.

Those capabilities remain part of the privileged intelligence plane defined by the main architecture.

## 15. Storage and retention

Trace persistence SHALL be separable from workspace persistence.

```text
Workspace configuration
  small / durable

AgentRun + execution evidence
  separately retained

large payloads / raw protocol bodies
  separately bounded
```

The storage layer SHOULD support configurable retention and payload-size limits.

Large results SHOULD use references/artifacts where practical rather than duplicating payloads across AgentRun, ExecutionRecord, and Investigation Packet storage.

## 16. Live versus historical behavior

The same model SHALL support both live and completed runs.

### Live

```text
agent running
  ↓
events stream into AgentRun
  ↓
Timeline/Graph/Waterfall update incrementally
```

### Historical

```text
completed AgentRun
  ↓
load persisted event graph
  ↓
replay/inspect without re-executing tools
```

Historical replay MUST be observational. It MUST NOT silently re-run MCP calls.

## 17. External ingestion

The core trace model SHALL be origin-agnostic so MCP Inspector X can later ingest evidence produced by external runtimes.

Possible adapters include:

```text
OpenTelemetry collector/backend
Inspector gateway
instrumented MCP SDK client
runtime-specific agent integration
server-side trace exporter
recorded protocol transcript
```

Adapters SHALL normalize into the same AgentRun/McpCallEvent/TraceSpan model.

## 18. Failure and uncertainty representation

The UI MUST distinguish verified evidence from inference.

Examples:

```text
confirmed
  request observed at gateway
  response observed
  trace parent observed
  sourceSymbolId emitted

partial
  server span observed but client call missing

inferred
  likely source dependency from static graph

unknown
  agent origin not observable
```

The product MUST NOT fabricate missing parentage merely to produce a visually complete graph.

## 19. Performance requirements

Tracing MUST NOT materially block MCP execution.

Capture SHOULD be asynchronous after essential request/response bookkeeping where possible.

The implementation SHOULD support:

- bounded in-memory buffering;
- batched persistence;
- backpressure;
- sampling/configurable payload capture;
- virtualized UI for large runs;
- incremental graph/timeline rendering.

If trace persistence fails, the MCP call itself SHOULD continue unless the deployment explicitly configures observability as fail-closed.

## 20. Product boundaries

This feature does not make MCP Inspector X an agent runtime.

MCP Inspector X observes and inspects agent-originated MCP activity; it does not need to own agent planning, prompting, model inference, or orchestration.

```text
Agent runtime
  owns reasoning/orchestration

MCP Inspector X
  owns observable MCP execution evidence
  owns visualization
  owns source/runtime correlation
  owns diagnostic export
```

## 21. Non-goals for the first implementation

The first implementation SHALL NOT require:

- support for every agent framework;
- reconstruction of private model chain-of-thought;
- packet-level network interception;
- arbitrary MITM proxying of encrypted traffic;
- automatic source correlation for every language/runtime;
- permanent retention of complete MCP payloads;
- replay that re-executes tools automatically.

## 22. Implementation sequence

### Phase 1 — Trace domain model

Deliver:

- `AgentRun`;
- `McpCallEvent`;
- run/call correlation identifiers;
- causal parentage;
- MRTR/task grouping;
- unit tests for ordering and partial traces.

### Phase 2 — Inspector-originated capture

Instrument the existing MCP execution path first.

Deliver:

- one AgentRun for an Inspector execution session;
- MCP call events from real tool calls;
- timestamps/status/duration;
- protocol evidence association.

### Phase 3 — Gateway capture

Deliver:

- run context ingress where available;
- automatic logical call creation;
- gateway request/response observation;
- external-client `unknown` origin fallback.

### Phase 4 — Trace ingestion and source correlation

Deliver:

- TraceSpan ingestion;
- parent/child tree construction;
- MCP call ↔ runtime span association;
- existing `sourceSymbolId` correlation;
- exact revision attachment where available.

### Phase 5 — UI projections

Deliver:

```text
Timeline
Waterfall
Graph
List
Workspace overlay
```

All projections SHALL reuse existing expanded/focus result/source/trace components.

### Phase 6 — Agent Investigation Packets

Deliver export for:

- one MCP call;
- selected calls;
- complete AgentRun.

### Phase 7 — External runtime adapters

Add runtime-specific integrations only after the generic observation/gateway/OTel seams are proven.

## 23. Acceptance criteria

The feature is accepted when an operator can:

1. run or observe an agent/application that performs multiple MCP calls;
2. open one Agent Run in MCP Inspector X;
3. see every observed MCP call with start/end time, status, server, tool, and protocol metadata;
4. distinguish sequential from concurrent calls;
5. inspect MRTR rounds and task lifecycle under one logical tool call;
6. switch the same run between Timeline, Waterfall, Graph, List, and Workspace projections;
7. expand one call to inspect arguments, result, protocol, trace, and source information;
8. correlate runtime spans to source symbols where evidence exists;
9. see explicit `partial`, `inferred`, or `unknown` states where evidence is incomplete;
10. create an Investigation Packet from one call, selected calls, or the complete run;
11. enforce backend authorization, redaction, and tenant isolation;
12. inspect a historical run without re-executing its tools.

## 24. Consequences

### Positive

- Agent behavior becomes inspectable without coupling Inspector X to one agent framework.
- Existing workspace/result/source/trace features gain a higher-level execution context.
- Parallel MCP activity becomes understandable rather than appearing as unrelated logs.
- Investigation Packets can carry complete causal evidence.
- Runtime and source intelligence become directly useful for agent debugging.
- The same architecture supports Inspector-originated, gateway-observed, and externally ingested traces.

### Negative

- Storage volume increases substantially when payload capture is enabled.
- Partial traces are unavoidable for uninstrumented external systems.
- Reliable cross-process correlation depends on propagated context and instrumentation quality.
- Tenant/privacy policy becomes more important because arguments/results can contain sensitive data.
- Large agent runs require careful UI virtualization and graph reduction.

## 25. Rejected alternatives

### Flat MCP request log

Rejected because it loses parentage, concurrency, MRTR grouping, task lifecycle, and source correlation.

### Force all agents to use an MCP Inspector X-specific SDK

Rejected because it would unnecessarily couple the product to agent runtimes and exclude generic MCP clients.

### Make the gateway mandatory for all tracing

Rejected because server-side and standard telemetry ingestion remain valuable and because some deployments cannot route all traffic through one gateway.

### Infer a complete trace from server logs

Rejected because missing client-side evidence cannot be reconstructed reliably.

### Build a separate agent-observability product

Rejected because the data and interaction model belong naturally to the existing MCP workspace, execution history, telemetry, source intelligence, and Investigation Packet architecture.

## 26. Architectural boundary

The final dependency shape is:

```text
Agent / CLI / Application
          │
          ├──── instrumented client ────┐
          │                              │
          └──── Inspector Gateway ───────┤
                                         ▼
                                  MCP execution evidence
                                         │
                          ┌──────────────┼───────────────┐
                          ▼              ▼               ▼
                     AgentRun       TraceSpan[]      SourceGraph
                          └──────────────┬───────────────┘
                                         ▼
                                  Combined Inspector
                                         │
                    ┌────────────────────┼────────────────────┐
                    ▼                    ▼                    ▼
                 Timeline              Graph          Investigation Packet
```

## 27. Final decision

Proceed with Agent-Run MCP Trace Capture as a first-class MCP Inspector X feature.

The canonical abstraction is a causal **AgentRun** containing logical MCP calls, not a flat protocol log.

The system SHALL support multiple observation points, preserve concurrency and uncertainty, correlate runtime spans to source intelligence when evidence permits, and render the same trace through Timeline, Waterfall, Graph, List, and Workspace views.

Agent runtime ownership remains outside MCP Inspector X. The product observes MCP behavior and makes it inspectable, reproducible, and transferable for diagnosis.