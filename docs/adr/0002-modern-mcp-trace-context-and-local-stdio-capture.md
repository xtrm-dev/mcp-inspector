# ADR-0002 — Modern MCP Trace Context and Local `stdio` Capture

**Status:** Accepted  
**Date:** 2026-08-18  
**Amends:** [ADR-0001 — Agent-Run MCP Trace Capture, Correlation, and Replay](./0001-agent-run-mcp-trace-capture-and-replay.md)  
**Decision scope:** MCP Inspector X trace correlation, transport capture, local process execution, workspace replay, and diagnostic evidence  
**Protocol target:** MCP `2026-07-28` modern era, with explicit legacy compatibility where supported

## 1. Context

ADR-0001 established Agent Run Trace as the causal model for MCP activity originating from agents, CLIs, applications, Inspector sessions, gateways, servers, and imported telemetry.

The original decision was intentionally transport-neutral. Subsequent verification against the MCP `2026-07-28` specification and current SDK behavior identified two decisions that must be explicit before implementation:

1. modern MCP trace context should be the preferred portable correlation mechanism;
2. local `stdio` execution and transparent `stdio` proxying must be first-class observation modes rather than incidental transport support.

Modern MCP simplifies trace reconstruction because requests are self-describing, protocol metadata is attached per request, W3C trace context has standardized MCP `_meta` keys, Multi Round-Trip Requests have explicit result states, and Tasks have a negotiated lifecycle extension.

At the same time, many important MCP servers are local processes launched over `stdio`. Local coding agents, desktop hosts, CLIs, and development tools often use these servers without any HTTP gateway. An HTTP-only capture design would therefore miss a major part of real MCP usage.

## 2. Decision

MCP Inspector X SHALL treat transport capture and causal correlation as separate dimensions.

```text
transport
├── streamable-http
├── stdio
└── custom

protocol era
├── modern
└── legacy

correlation
├── W3C trace context
├── Inspector run/call identity
├── observed protocol evidence
└── explicit inference
```

A modern MCP call may use either Streamable HTTP or `stdio`. A `stdio` call may negotiate either modern or legacy protocol behavior. Transport MUST NOT be used as a proxy for protocol era.

MCP Inspector X SHALL add local `stdio` process capture and transparent `stdio` proxying as first-class observation modes under ADR-0001.

## 3. Correlation hierarchy

The product SHALL apply the following correlation hierarchy, from strongest to weakest evidence:

```text
1. W3C trace context
   traceparent / tracestate / baggage

2. Inspector identity
   AgentRun.id / logicalCallId / captureSessionId

3. observed protocol evidence
   request IDs / timestamps / transport connection / task IDs

4. inference
   static source relationships / temporal heuristics
```

Higher-quality evidence MUST take precedence over weaker inference.

The UI and exported Investigation Packets MUST distinguish which relationship source was used.

Example:

```text
MCP call → server span
  correlation: traceparent
  confidence: runtime-confirmed

MCP call → source symbol
  correlation: sourceSymbolId
  confidence: runtime-confirmed

source symbol → downstream helper
  correlation: static source graph
  confidence: inferred
```

The Inspector MUST NOT fabricate a complete causal tree when trace context or run identity is absent.

## 4. Modern MCP trace context

For MCP `2026-07-28`, MCP Inspector X SHOULD preserve W3C/OpenTelemetry-compatible trace context carried through MCP request `_meta`.

Supported keys include:

```text
traceparent
tracestate
baggage
```

The capture layer SHALL preserve both:

```text
normalized trace identity
  traceId
  spanId
  parentSpanId

raw protocol evidence
  original _meta
  transport headers
  request/response envelope
```

Normalization enables correlation and visualization. Raw evidence enables protocol inspection and later verification.

Trace context MAY originate from:

- the agent or host application;
- an instrumented MCP client;
- MCP Inspector X;
- the Inspector gateway;
- an instrumented MCP server;
- an upstream OpenTelemetry system.

The Inspector SHALL propagate existing valid context when acting as client or proxy. It SHOULD create new context only when no usable upstream context exists and the capture policy allows it.

## 5. Self-contained modern requests

MCP `2026-07-28` removes the requirement for hidden protocol session state in the modern era. Each request carries the information required to process it, and `server/discover` can provide capabilities before execution.

This simplifies persisted execution evidence:

```text
McpCallEvent
├── protocolVersion
├── clientInfo
├── clientCapabilities
├── serverCapabilities
├── negotiatedExtensions
├── request envelope
├── response envelope
└── trace context
```

The Inspector SHOULD store enough per-call protocol evidence to inspect a historical execution without requiring the original live connection.

Application-level state handles returned by tools remain ordinary tool data and MUST NOT be confused with removed protocol-level session state.

## 6. HTTP observation

For modern Streamable HTTP, the Inspector gateway SHOULD capture and validate routing and protocol metadata including:

```text
MCP-Protocol-Version
Mcp-Method
Mcp-Name
Mcp-Param-*
```

Where present and valid, routing headers allow the gateway to classify a request before fully parsing its JSON body.

The gateway MUST still validate consistency between routing headers and the actual MCP envelope. Header metadata is evidence, not authority when it contradicts the request body or protocol rules.

HTTP capture SHALL preserve:

- request start/end time;
- method and endpoint;
- MCP routing headers;
- relevant cache metadata;
- request and response protocol envelopes;
- stream lifecycle where applicable;
- cancellation outcome;
- authentication/redaction metadata;
- trace context.

## 7. `stdio` as a first-class transport

MCP Inspector X SHALL support local `stdio` capture because many MCP servers are launched as subprocesses by agents and desktop clients.

The protocol channel is:

```text
client writes MCP JSON-RPC → server stdin
server writes MCP JSON-RPC → client stdout
server writes logs          → stderr
```

The capture implementation MUST enforce the transport distinction:

- `stdout` is MCP protocol traffic;
- `stdin` is MCP protocol traffic;
- `stderr` is a separate log stream;
- `stderr` output MUST NOT automatically be classified as an execution error;
- non-MCP output on `stdout` is a transport/protocol violation and SHALL be recorded explicitly.

## 8. `stdio` capture modes

### 8.1 Inspector-originated local process

MCP Inspector X launches and owns the MCP server process.

```text
MCP Inspector X
  spawn process
    ↓
  stdio transport
    ↓
  local MCP server
```

This mode provides complete client-side evidence and SHOULD be implemented first.

The Inspector controls:

- executable and arguments;
- working directory;
- selected environment references;
- process lifecycle;
- protocol-era negotiation;
- all MCP messages;
- cancellation;
- process exit status;
- `stderr` capture.

### 8.2 Transparent local `stdio` proxy

An external agent or application launches MCP Inspector X as the configured server command. Inspector X then launches the actual MCP server and transparently forwards protocol traffic.

```text
Agent / CLI / desktop host
          ↓ stdin/stdout
MCP Inspector X stdio proxy
          ↓ stdin/stdout
actual MCP server
```

Conceptual configuration:

```text
command: mcp-inspector-x
args:
  - stdio-proxy
  - --
  - python
  - server.py
```

The proxy SHALL preserve MCP behavior while recording request, response, notification, timing, process, and log evidence.

The proxy MUST NOT modify tool arguments or results except for explicit, documented protocol functionality such as valid trace-context propagation. Any modification MUST be represented in protocol evidence.

### 8.3 External process transcript import

A later adapter MAY import a previously recorded `stdio` transcript and process metadata.

Imported transcripts MUST be marked historical/imported and MUST NOT be represented as live capture.

## 9. Local process data model

ADR-0001's `McpCallEvent` SHALL add transport and process correlation fields.

```text
McpCallEvent
├── transport
│   ├── streamable-http
│   ├── stdio
│   └── custom
├── connectionId?
├── captureSessionId?
├── processId?
├── processIdentity?
├── protocolEra
├── protocolVersion
└── existing call/trace/source evidence
```

The `stdio` capture subsystem SHALL introduce:

```text
StdioCapture
├── id
├── captureMode
│   ├── inspector-originated
│   ├── transparent-proxy
│   └── imported
├── agentRunId?
├── captureSessionId
├── connectionId
├── command
├── argsRedacted[]
├── cwd?
├── environmentReferences[]
├── pid?
├── spawnedAt
├── exitedAt?
├── exitCode?
├── signal?
├── protocolEra
├── protocolVersion
├── negotiatedCapabilities
├── protocolMessages[]
├── stderrEvents[]
├── observedCallIds[]
└── redactions[]
```

Raw secret values MUST NOT be stored in `environmentReferences`.

## 10. Connection identity versus run identity

A `stdio` connection is not automatically an Agent Run.

An agent or host may keep one local MCP server process alive across multiple prompts, conversations, workflows, or users.

Therefore:

```text
stdio connection != AgentRun
process lifetime   != AgentRun
capture session    != necessarily AgentRun
```

Perfect grouping requires reliable run context such as:

- propagated W3C trace context;
- explicit `AgentRun.id` metadata from an integration;
- a runtime-specific adapter;
- an explicit user-created capture session with documented scope.

When run identity is unavailable, calls SHALL remain inspectable under their connection/capture session and SHALL use:

```text
origin: unknown
agentRunId: absent
captureSessionId: present
```

The product MUST NOT infer one Agent Run solely because calls share a process or `stdio` connection.

## 11. Protocol-era negotiation over `stdio`

Modern MCP is not HTTP-only.

The official SDK's modern `stdio` path performs protocol-era negotiation and pins the selected era for the lifetime of the connection.

MCP Inspector X SHALL preserve:

```text
transport: stdio
protocolEra: modern | legacy
protocolVersion: exact selected revision
negotiationMode: auto | modern | legacy
negotiationEvidence
```

If negotiation fails, the failure SHALL be represented as a connection/protocol failure rather than a tool-call failure.

Pinned modern or legacy modes MUST NOT silently fall back unless the selected connection policy explicitly permits fallback.

## 12. Transport-specific cancellation

The normalized execution state may expose one `cancel` action, but transport evidence MUST preserve how cancellation occurred.

Examples:

```text
Streamable HTTP modern
  close/cancel the active request stream according to SDK semantics

stdio
  send the applicable MCP cancellation notification/mechanism
  preserve process state unless process termination is explicitly requested

Task-backed execution
  tasks/cancel
  cancellation remains cooperative
```

The UI MUST distinguish:

- logical call cancellation;
- task cancellation request;
- transport-stream closure;
- local process termination.

Terminating a local MCP server process is a stronger operation than cancelling one call and MUST require an explicit action.

## 13. MRTR and Tasks improvements

Modern MCP makes multi-stage execution easier to represent deterministically.

### 13.1 Multi Round-Trip Requests

One logical call groups all rounds:

```text
round 1
  resultType: input_required
  inputRequests
  requestState

round 2
  inputResponses
  requestState
  resultType: complete
```

The trace model SHALL preserve one `logicalCallId` across rounds regardless of HTTP or `stdio` transport.

### 13.2 Tasks extension

Task-backed calls SHALL preserve:

```text
tools/call
  resultType: task
  taskId
    ↓
tasks/get
    ↓
tasks/update when input is required
    ↓
tasks/cancel when requested
    ↓
terminal result/error
```

Task IDs are durable handles and MAY outlive one transport connection. The task lifecycle therefore belongs to the logical call, not solely to the HTTP request or `stdio` connection that created it.

## 14. Workspace and UI implications

Timeline, Waterfall, Graph, List, and Workspace views SHALL render HTTP and `stdio` calls through the same logical-call components.

Transport-specific evidence remains inspectable through local tabs:

```text
[Result]
[Arguments]
[Protocol]
[Trace]
[Source]
[Transport]
[Process]
[Logs]
[History]
```

For HTTP calls:

```text
Transport
  request headers
  response headers
  routing metadata
  stream/cancellation evidence
```

For `stdio` calls:

```text
Transport
  protocol messages
  connection identity
  process identity

Process
  command / redacted args / cwd
  spawn and exit evidence

Logs
  stderr timeline
```

The graph MAY group calls by:

- Agent Run;
- capture session;
- `stdio` process;
- server;
- tool;
- trace subtree.

## 15. Investigation Packet implications

Investigation Packets for observed local calls SHOULD include transport-appropriate evidence.

For `stdio`:

```text
Local process
├── capture mode
├── redacted command/arguments
├── working directory
├── process identity
├── selected protocol era/version
├── connection/capture-session identity
├── ordered protocol messages
├── relevant stderr excerpts
├── exit status
└── explicit redactions
```

Packets MUST distinguish:

- MCP execution failure;
- malformed `stdout` protocol traffic;
- process crash or signal termination;
- non-zero process exit;
- informational `stderr` logs;
- call/task cancellation.

The default packet SHOULD include bounded relevant excerpts, not the complete unbounded process transcript.

## 16. Security boundary

Local process execution is part of the privileged intelligence plane.

A hosted multi-tenant user MUST NOT be allowed to submit arbitrary commands for server-side execution.

```text
privileged/local deployment
  stdio process spawn allowed by policy

hosted public plane
  remote authorized MCP endpoints
  no arbitrary process spawn
```

The `stdio` runner/proxy SHALL support:

- executable allowlists or explicit operator confirmation;
- bounded environment inheritance;
- secret references rather than persisted secret values;
- working-directory policy;
- process timeouts and resource limits;
- redaction before persistence/export;
- audit evidence;
- optional sandboxing.

Trace baggage and other propagated metadata MUST be treated as untrusted input. Sensitive baggage fields MUST be removed or redacted according to policy.

## 17. Performance and reliability

Trace capture MUST not block normal MCP traffic beyond bounded bookkeeping.

The `stdio` proxy SHALL use backpressure-safe streaming and MUST avoid buffering unbounded protocol or log output in memory.

Recommended behavior:

```text
read protocol line
  validate framing
  timestamp and identify direction
  forward immediately
  enqueue bounded persistence asynchronously
```

If optional persistence fails, traffic SHOULD continue unless observability is explicitly configured fail-closed.

Protocol corruption, invalid framing, or unsafe process behavior MAY require fail-closed termination because forwarding invalid MCP traffic would violate the proxy contract.

## 18. Implementation sequence

### Phase 1 — Domain amendment

Deliver:

- transport fields on `McpCallEvent`;
- correlation-strength/provenance model;
- `StdioCapture` contract;
- explicit connection versus run identity;
- unit tests.

### Phase 2 — Inspector-originated `stdio`

Deliver:

- privileged local process runner;
- official SDK `stdio` connection;
- modern/legacy era policy;
- process and protocol evidence;
- separate `stderr` capture;
- cancellation and process termination controls.

### Phase 3 — Transparent `stdio` proxy

Deliver:

- CLI `stdio-proxy -- <command> [args...]`;
- bidirectional JSON-RPC forwarding;
- ordered protocol transcript;
- capture-session identity;
- non-MCP `stdout` violation handling;
- bounded logging/persistence.

### Phase 4 — Modern trace propagation

Deliver:

- `traceparent`, `tracestate`, and `baggage` preservation;
- Agent Run / logical call correlation;
- gateway and `stdio` propagation tests;
- provenance displayed in UI.

### Phase 5 — Unified UI

Deliver:

- transport/process/log tabs;
- grouping by connection/process/capture session;
- HTTP and `stdio` calls in Timeline/Waterfall/Graph/List/Workspace;
- partial run identity representation.

### Phase 6 — Diagnostic export

Deliver transport-aware Investigation Packets for:

- one local call;
- one `stdio` connection/capture session;
- selected calls;
- one Agent Run.

## 19. Acceptance criteria

This amendment is implemented when an operator can:

1. launch a local MCP server from MCP Inspector X over `stdio`;
2. select and inspect the negotiated protocol era and exact version;
3. inspect ordered stdin/stdout MCP traffic without mixing it with `stderr` logs;
4. see `stderr` informational output without it being falsely classified as an error;
5. cancel one logical call without automatically terminating the whole process;
6. explicitly terminate the local process when required;
7. configure an external agent to use MCP Inspector X as a transparent `stdio` proxy;
8. inspect the proxy-observed tool calls in Timeline, Waterfall, Graph, List, and Workspace views;
9. correlate calls through valid W3C trace context where available;
10. see connection/capture-session grouping without a fabricated Agent Run when run identity is absent;
11. inspect MRTR rounds and Tasks under one logical call for either HTTP or `stdio`;
12. export a transport-aware Investigation Packet with explicit redactions;
13. enforce the privileged execution boundary for process spawning;
14. pass protocol, concurrency, cancellation, redaction, and conformance tests for supported modes.

## 20. Consequences

### Positive

- Local agent and desktop MCP traffic becomes observable without requiring HTTP.
- Standard trace propagation reduces proprietary integration requirements.
- Modern self-contained requests make historical evidence more reproducible.
- One causal model supports HTTP, `stdio`, MRTR, and Tasks.
- Process logs and protocol messages become navigable without conflation.
- Existing source correlation and Investigation Packets gain local execution evidence.

### Negative

- A safe process runner/proxy adds substantial security and lifecycle complexity.
- `stdio` connection lifetime does not inherently identify an agent run.
- Complete traces still require cooperating instrumentation or propagated context.
- Protocol transcripts and logs can contain sensitive data and require strict retention/redaction.
- Transport-specific cancellation and failure semantics must remain visible beneath normalized UI state.

## 21. Rejected alternatives

### HTTP-only observation

Rejected because it excludes a major class of local MCP servers and agent integrations.

### Treat one `stdio` process as one Agent Run

Rejected because processes are commonly reused across multiple agent turns and workflows.

### Merge `stderr` into the MCP protocol transcript

Rejected because `stderr` is a separate logging channel and does not necessarily indicate an error.

### Use only Inspector-generated IDs

Rejected because W3C trace context is the portable standard across agents, SDKs, gateways, servers, and downstream services.

### Require every agent to adopt an Inspector-specific SDK

Rejected because transparent proxying and standard trace context provide a framework-neutral path.

### Expose arbitrary `stdio` execution in the public hosted plane

Rejected because process spawning belongs to a privileged/local trust boundary.

## 22. Relationship to ADR-0001

ADR-0001 remains authoritative for:

- the causal `AgentRun` model;
- logical MCP calls;
- Timeline/Waterfall/Graph/List/Workspace projections;
- partial observability;
- runtime-to-source correlation;
- Investigation Packet integration.

ADR-0002 makes the following additions mandatory:

```diff
 observation sources
+  local stdio process capture
+  transparent stdio proxy

 correlation
+  W3C trace context is preferred portable evidence
+  Inspector IDs remain product-level grouping

 McpCallEvent
+  transport
+  connectionId
+  captureSessionId
+  process identity

 security
+  local process spawning is privileged-only
```

Where ADR-0001 and ADR-0002 appear ambiguous, ADR-0002 governs transport capture and correlation precedence.

## 23. References

Primary references verified for this amendment:

- MCP `2026-07-28` specification release and changelog
- MCP standard transports (`stdio` and Streamable HTTP)
- W3C Trace Context propagation in MCP `_meta`
- MCP TypeScript SDK V2 protocol-era behavior
- MCP Tasks extension (`io.modelcontextprotocol/tasks`)

Canonical locations:

- `https://modelcontextprotocol.io/specification/2026-07-28`
- `https://blog.modelcontextprotocol.io/posts/2026-07-28/`
- `https://modelcontextprotocol.io/specification/draft/basic/transports`
- `https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions`
- `https://modelcontextprotocol.io/extensions/tasks/overview`

## 24. Final decision

Proceed with modern trace-context propagation and first-class local `stdio` capture as mandatory extensions to Agent Run Trace.

MCP Inspector X SHALL use W3C trace context as the preferred portable correlation mechanism, while preserving Inspector run/call identities and explicit evidence provenance.

MCP Inspector X SHALL support privileged Inspector-originated `stdio` execution and transparent local `stdio` proxying, with process, protocol, log, cancellation, security, and redaction semantics represented explicitly.

HTTP and `stdio` calls SHALL converge into the same causal Agent Run and logical-call model without erasing their transport-specific evidence.