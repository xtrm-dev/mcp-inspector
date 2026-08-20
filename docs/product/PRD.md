# MCP Inspector X — Product Requirements Document

**Status:** Canonical / living product requirements<br>
**Initial version:** 2026-08-19<br>
**Product:** MCP Inspector X<br>
**Repository:** `xtrm-dev/mcp-inspector`<br>
**Protocol target:** MCP `2026-07-28` modern era, with explicit legacy compatibility where supported<br>
**Architecture decisions:** [`../architecture.md`](../architecture.md), [`../adr/0001-agent-run-mcp-trace-capture-and-replay.md`](../adr/0001-agent-run-mcp-trace-capture-and-replay.md), [`../adr/0002-modern-mcp-trace-context-and-local-stdio-capture.md`](../adr/0002-modern-mcp-trace-context-and-local-stdio-capture.md)

---

## 1. Purpose of this document

This PRD is the canonical product-level source of truth for MCP Inspector X.

It defines **what the product must become**, the user problems it solves, the product surfaces and workflows it must support, the V1 completion contract, later product direction, and explicit non-goals.

It intentionally does **not** decide low-level implementation topology, storage engines, internal event buses, concrete persistence technology, package boundaries beyond already accepted architectural constraints, or deployment infrastructure. Those decisions belong in ADRs.

The relationship is:

```text
PRD
  defines WHAT the product must do and WHY

ADRs
  define HOW architectural requirements are satisfied

Roadmap / issues / Beads
  define WHEN and IN WHAT IMPLEMENTATION ORDER work is delivered
```

When implementation, an ADR, an issue, or a local-agent handoff conflicts with this PRD, the conflict must be made explicit and either:

1. the implementation is corrected;
2. the relevant ADR is amended; or
3. this PRD is deliberately amended.

Silent divergence is not acceptable.

---

## 2. Product definition

MCP Inspector X is an independent, general-purpose **visual MCP inspection, execution, observability, and diagnostic workbench**.

It is designed for systems in which one or more MCP clients, agents, applications, or operators interact with one or more MCP servers and need more than a single request form.

The product combines five jobs that are usually fragmented across protocol inspectors, API clients, tracing tools, source browsers, logs, and agent handoff documents:

```text
Discover MCP capabilities
        ↓
Configure and execute them
        ↓
Inspect protocol + results + history
        ↓
Correlate runtime behavior with source
        ↓
Transfer bounded evidence to an agent/human
```

The canonical product mental model is a **workspace containing inspectable MCP capabilities and executions**, not a one-tool-at-a-time form.

MCP Inspector X is not the official Model Context Protocol Inspector. The official Inspector is an upstream reference, compatibility target, and source of useful implementation patterns. MCP Inspector X exists to pursue a different product emphasis: multi-server/multi-capability workspaces, concurrent execution, deep evidence, source/runtime correlation, and agent-run observability.

---

## 3. Product vision

An operator should be able to connect MCP Inspector X to a real MCP environment and answer, from one coherent interface:

- What servers are available and what do they expose?
- Which protocol era/version and extensions are actually in use?
- What tools, resources, prompts, Apps/extensions, and task-capable operations exist?
- How do I configure and exercise several capabilities together?
- What exactly was sent and returned?
- Which requests ran concurrently, failed, timed out, required input, or became durable Tasks?
- How did this execution differ from the previous successful one?
- What happened inside the server after the MCP call arrived?
- Which exact deployed revision and source symbols were involved?
- What MCP calls did an agent make during a run, and in what causal order?
- Can I give a coding agent a bounded, deterministic evidence packet without manually copying logs, payloads, traces, and source snippets?

The intended end state is:

```text
MCP Inspector X
│
├── Servers / connections
├── Capability catalog
├── Multi-capability workspaces
├── Executions / history
├── Agent Runs
├── Protocol / transport evidence
├── Runtime traces
├── Source intelligence
└── Investigation Packets
```

All of these surfaces must describe the same underlying reality rather than create disconnected copies of execution state.

---

## 4. Target users

### 4.1 MCP server developer

Needs to develop and debug one or more MCP servers, test schemas and behavior, inspect modern/legacy negotiation, reproduce failures, exercise MRTR/Tasks, and inspect protocol evidence.

Primary value:

- faster iteration;
- reproducible executions;
- schema-driven forms;
- transport/protocol visibility;
- history and comparison;
- source/runtime correlation.

### 4.2 Agent / application developer

Builds agents or applications that consume multiple MCP servers.

Primary value:

- see which MCP calls the agent actually made;
- inspect ordering/concurrency;
- understand latency and failures;
- validate transport/protocol behavior;
- inspect local `stdio` and remote HTTP servers in one model;
- hand evidence to coding agents.

### 4.3 Platform / SRE / infrastructure operator

Operates MCP services rather than developing one isolated tool.

Primary value:

- multi-server inventory;
- exact deployment/source revision linkage;
- runtime trace correlation;
- protocol/network evidence;
- historical comparison;
- security-conscious diagnostic export.

### 4.4 Technical product owner / integrator

Needs to understand a system without reading implementation details first.

Primary value:

- visual workspace;
- clear server/tool status;
- expandable detail instead of terminal-only output;
- side-by-side comparison;
- deterministic evidence for delegation.

### 4.5 Security / protocol investigator

Needs to understand what was executed, through which identity/transport, with which metadata and privileges.

Primary value:

- explicit evidence provenance;
- redaction records;
- safe/privileged plane separation;
- transport/process evidence;
- authentication and authorization visibility.

---

## 5. Product principles

### P-01 — Capability-oriented, not tool-form-oriented

The product must model MCP servers and capabilities as durable entities. Tools are the deepest initial execution workflow, but the product must remain capable of representing resources, prompts, extensions/Apps, Tasks, and future MCP capability types.

### P-02 — Multi-server is the normal case

The design must assume a workspace may contain capabilities from many MCP servers simultaneously.

### P-03 — One state, many projections

Graph, Grid, List, Timeline, Waterfall, expanded cards, focused views, history, and Investigation Packets must project shared domain evidence rather than own independent copies of it.

### P-04 — Preserve evidence before rendering

Raw protocol/transport evidence and normalized execution state must be preserved separately from presentation-specific rendering.

### P-05 — Concurrency is first-class

The product must not serialize independent executions merely because the UI displays a list.

### P-06 — Protocol fidelity over convenience

Modern/legacy era, exact protocol revision, negotiated extensions, MRTR rounds, Tasks lifecycle, cancellation, transport behavior, and uncertainty must remain inspectable.

### P-07 — Never fabricate missing observability

Unknown, partial, inferred, and runtime-confirmed relationships must remain distinguishable.

### P-08 — Progressive disclosure

The default workspace must remain compact. Deep protocol, source, process, trace, logs, and history detail should appear through expansion/focus rather than permanent visual clutter.

### P-09 — Local power without hosted arbitrary execution

Local/privileged deployments may spawn `stdio` processes. A future hosted public plane must not expose arbitrary server-side command execution.

### P-10 — Agent handoff is a product surface

Diagnostic evidence must be transferable as a deterministic artifact, not merely copyable as arbitrary screenshots or logs.

### P-11 — Revision-aware source, not “current main” source

When runtime execution is correlated to source, the product must prefer the exact deployed revision and clearly label when that revision is unknown.

### P-12 — The Inspector is not an agent runtime

The product may observe agents and export evidence to agents. It does not own model reasoning, planning, orchestration, or private chain-of-thought.

---

## 6. Protocol and ecosystem baseline

### 6.1 Formal protocol target

The formal modern protocol target is MCP `2026-07-28`.

“MCP 2.0” may be used informally when discussing the V2 SDK/tooling generation, but product requirements and compatibility claims must use exact protocol revisions/eras where precision matters.

### 6.2 Required eras

MCP Inspector X must support:

```text
modern era
  primary target: 2026-07-28

legacy era
  explicitly negotiated/fallback compatibility
  only for revisions the adapter declares supported
```

The product must never imply that `stdio` means legacy or that Streamable HTTP means modern. Transport and protocol era are independent dimensions.

### 6.3 Standard transports

The product direction includes:

- Streamable HTTP;
- local `stdio`;
- explicitly isolated legacy transport compatibility where necessary;
- future custom transport adapters through product-owned seams rather than protocol assumptions in the UI.

### 6.4 Modern protocol behaviors that must be product-visible

Where applicable and supported by the negotiated server/client capabilities:

- `server/discover`;
- per-request protocol metadata;
- exact client/server identity and capabilities;
- extension negotiation;
- `complete` and `input_required` multi-round-trip outcomes;
- Tasks extension lifecycle;
- W3C trace context in MCP metadata;
- modern Streamable HTTP routing/protocol headers;
- JSON Schema 2020-12 input/output semantics;
- pagination and cache metadata where exposed;
- resource/prompt/tool list changes and subscriptions where supported;
- MCP Apps/extensions where supported by later product phases.

### 6.5 Conformance language

The product may be described as **MCP `2026-07-28`-ready** when its architecture and supported paths target the revision.

It must not claim MCP conformance for a behavior that has not passed the applicable official conformance suite/scenario.

Conformance claims must be scoped, for example:

```text
conformant for supported client tool-call scenarios
```

rather than an unqualified whole-product claim when unsupported areas remain.

---

## 7. Core product entities

The PRD assumes the following user-visible concepts. Exact internal schemas belong to architecture.

### 7.1 Server

A configured or discovered MCP server endpoint/process definition.

Expected user-visible properties include:

- stable server identity;
- display name;
- connection status;
- transport;
- protocol policy;
- negotiated era/revision;
- server identity/capabilities;
- extensions;
- authentication status;
- source/deployment mapping when configured;
- local-process metadata for privileged `stdio` servers.

### 7.2 Capability

A server-scoped MCP capability.

Stable identity must include at minimum:

```text
server/provider identity
capability type
capability name/URI/template identity
```

A plain tool name is not a globally sufficient identity.

Capability types include, at minimum in product direction:

- tools;
- resources;
- resource templates;
- prompts;
- Apps/extension-provided UI or capability surfaces;
- Tasks-associated operations/lifecycle;
- protocol/client utility capabilities where inspection is useful.

### 7.3 Workspace

A durable user-defined inspection layout containing selected capabilities, execution state, presentation state, grouping, filters, and optional observed Agent Runs.

### 7.4 Execution

One logical invocation/read/get operation, potentially containing multiple protocol rounds, task transitions, transport events, and runtime trace evidence.

### 7.5 Agent Run

A causal grouping of MCP activity belonging to one observed agent/application run when reliable correlation exists.

### 7.6 Capture Session

An observation window or connection grouping used when Agent Run identity is absent or incomplete, especially for long-lived local `stdio` processes.

### 7.7 Protocol Evidence

Request/response and negotiation evidence required to explain what happened on the MCP wire without relying only on normalized result objects.

### 7.8 Source Graph

A revision-aware graph describing relevant implementation symbols and dependencies for an MCP capability.

### 7.9 Trace

Runtime spans and relationships associated with an execution/Agent Run.

### 7.10 Investigation Packet

A deterministic, redacted export containing enough bounded evidence for a human or coding agent to investigate one or more executions without reconstructing context manually.

---

## 8. Information architecture

The target application shell must support these primary surfaces:

```text
Workspace
Servers
Capabilities
Executions
Agent Runs
Source / Runtime
Settings
```

These are product concepts, not necessarily permanent top-level routes. The final navigation design may combine surfaces if usability improves.

### 8.1 Workspace

The default daily-use surface.

Must support:

- Graph projection;
- Grid projection;
- List projection;
- selection and bulk actions;
- tool/capability cards with collapsed → expanded → focus/fullscreen presentation;
- persisted layouts;
- server/capability filtering;
- observed Agent Run overlays;
- status, latency, protocol, and error summaries without requiring expansion.

### 8.2 Servers

Connection/catalog management and server-centric inspection.

### 8.3 Capabilities

Searchable cross-server catalog for tools, resources, prompts, and extensions.

### 8.4 Executions

Historical execution list, filters, comparison, replay-of-evidence, and export.

### 8.5 Agent Runs

Live/historical agent/application MCP activity represented as Timeline, Waterfall, Graph, List, and Workspace projections.

### 8.6 Source / Runtime

Source graph, code viewer, runtime trace, and combined source-runtime views.

### 8.7 Settings

Capture policy, secrets/credential references, retention, local runner policy, source integrations, trace integrations, and product preferences.

---

## 9. Server management requirements

### SRV-01 — Add remote servers

Users must be able to add Streamable HTTP MCP servers by URL with a display name and protocol policy.

### SRV-02 — Add local `stdio` servers

Privileged/local deployments must allow configuring a local command, arguments, working directory, and bounded environment references.

### SRV-03 — Persist server catalog

Configured servers must persist across restarts unless the user chooses an ephemeral session.

### SRV-04 — Import/export configuration

The product should support a portable server catalog format and later adapters for common MCP host configuration formats.

Import must never silently persist plaintext secrets that were intended to remain external references.

### SRV-05 — Connection test

A server configuration must be testable independently before adding capabilities to a workspace.

The result must distinguish:

- DNS/network/connectivity failure;
- authentication failure;
- protocol negotiation failure;
- unsupported era/revision;
- server discovery failure;
- local process spawn/exit failure;
- malformed transport/protocol traffic.

### SRV-06 — Negotiation visibility

The server detail surface must expose configured protocol policy, negotiated era, exact revision, server identity/capabilities, extensions, and transport.

### SRV-07 — Multiple same-name servers

The product must handle servers with identical display names or overlapping capability names without identity collision.

### SRV-08 — Server enable/disable

Users should be able to disable a configured server without deleting its configuration/history.

### SRV-09 — Health and reconnect

Users must see connection state and be able to retry/reconnect where transport semantics permit.

### SRV-10 — Local process safety

Starting/stopping a `stdio` server process is a privileged action distinct from cancelling one MCP request.

---

## 10. Capability discovery and catalog requirements

### CAP-01 — Cross-server discovery

The catalog must aggregate discovered capabilities from multiple connected servers.

### CAP-02 — Capability types

The catalog must be extensible beyond tools. Product direction includes tools, resources, resource templates, prompts, Tasks/extensions, and Apps/extensions.

### CAP-03 — Stable identity

Each catalog item must have a stable composite identity scoped to the server/provider and capability type.

### CAP-04 — Search/filter

Users must be able to search/filter by server, capability type, name, description, tags/annotations where available, transport, extension, and availability.

### CAP-05 — Schema/documentation visibility

Capability cards/details must show protocol-provided descriptions, schemas, annotations, output schema where available, and raw metadata.

### CAP-06 — Pagination

Discovery must correctly handle paginated capability lists without hiding pagination behavior from protocol inspection.

### CAP-07 — Refresh/list changes

Users must be able to refresh discovery manually. Where the protocol/server supports list-change notifications or subscriptions, the product may update automatically while preserving evidence of the change.

### CAP-08 — Add to workspace

One or many catalog items must be addable to the active workspace.

### CAP-09 — Capability availability

If a previously saved capability disappears, the workspace must preserve the node/history and mark current availability explicitly rather than silently deleting it.

---

## 11. Tool workflow requirements

Tools are the primary V1 execution workflow.

### TOOL-01 — Schema-driven parameter form

The product must generate an editable form from the tool input schema, supporting JSON Schema 2020-12 constructs used by MCP SDKs.

At minimum the form system must correctly handle:

- primitive types;
- objects and nested objects;
- arrays;
- enums/const;
- required versus optional fields;
- defaults;
- nullable/union constructs;
- `$ref` / `$defs`;
- `oneOf`, `anyOf`, and `allOf` where safely representable;
- conditional constructs with a raw-JSON fallback when a polished form is not possible.

### TOOL-02 — Raw JSON mode

Every tool invocation must offer raw JSON argument editing as an escape hatch from the generated form.

### TOOL-03 — Independent node configuration

Each workspace tool node must retain its own arguments/configuration independently, including two nodes referencing the same tool with different arguments if the user chooses.

### TOOL-04 — Run one

A tool can be invoked independently without affecting unrelated nodes.

### TOOL-05 — Run selected

Users can select multiple nodes and run them concurrently with bounded concurrency.

### TOOL-06 — Run all

Users can execute all runnable workspace nodes subject to validation and concurrency policy.

### TOOL-07 — Failure isolation

Failure/cancellation of one execution must not automatically cancel independent sibling executions.

### TOOL-08 — Retry

An execution can be retried with the same arguments or edited arguments while retaining the prior execution in history.

### TOOL-09 — Cancellation

The product must expose logical cancellation while preserving the transport-specific mechanism and outcome.

### TOOL-10 — Result inspection

Tool results must support structured, raw, and renderer-appropriate views without discarding original data.

### TOOL-11 — Output schema

Where an output schema is provided, the product should validate/display conformance without destroying a non-conforming raw result.

### TOOL-12 — Error taxonomy

The UI must distinguish protocol/transport errors, tool-returned errors, authorization errors, cancellation, timeout, renderer failure, process failure, and Inspector-internal failure where evidence allows.

---

## 12. Resource workflow requirements

Resources are part of the whole-product direction and required for complete V1 capability coverage.

### RES-01 — List resources

Users must be able to inspect listed resources across servers.

### RES-02 — Resource templates

Resource templates must expose variables/schema and allow form-driven URI construction where applicable.

### RES-03 — Read resource

Users must be able to read a resource and inspect returned text/binary/media/embedded content metadata using appropriate renderers.

### RES-04 — Resource history

Reads must be stored as executions/evidence so users can compare content over time where retention is enabled.

### RES-05 — Subscription/change visibility

Where supported, resource changes/subscriptions must be inspectable without conflating them with ordinary tool execution.

### RES-06 — Large resources

Large resource payloads must use bounded/virtualized or artifact-backed rendering rather than freezing the UI.

---

## 13. Prompt workflow requirements

### PRM-01 — List prompts

Users must be able to browse prompts across connected servers.

### PRM-02 — Prompt argument form

Prompt variables must be editable through schema/metadata-derived controls with raw fallback where needed.

### PRM-03 — Get/render prompt

Users must be able to execute `prompts/get` and inspect the resulting messages/content in both human-readable and raw forms.

### PRM-04 — MRTR/input requirements

Modern `input_required` behavior for prompts must fit the same logical multi-round-trip execution model used by tools/resources where the protocol supports it.

### PRM-05 — Compare prompt outputs

Historical prompt results must be comparable without re-execution.

---

## 14. Modern multi-round-trip requirements

### MRTR-01 — One logical execution

`input_required` must not create unrelated execution records. All rounds remain children of one logical execution.

### MRTR-02 — User/model input presentation

Input requests must be rendered according to their schemas/content and allow the operator to supply responses.

### MRTR-03 — Round history

Every round must preserve request state, requested input, provided response, timing, and final outcome as inspectable evidence.

### MRTR-04 — Resume/retry semantics

The UI must accurately represent retry/resume behavior required by the protocol/SDK rather than simulating a new call.

### MRTR-05 — Transport independence

The logical MRTR model must work across supported HTTP and `stdio` paths.

---

## 15. Tasks extension requirements

### TASK-01 — Extension negotiation

Task behavior is available only when negotiated/advertised. The product must not assume Tasks support.

### TASK-02 — Task-backed call

A call returning a task handle is not a failed or completed ordinary execution. It enters a durable task-backed lifecycle.

### TASK-03 — Task status

Users must be able to inspect/poll task status through the supported extension semantics.

### TASK-04 — Task input

If a Task reaches `input_required`, required input must be surfaced and submitted through the appropriate task update mechanism.

### TASK-05 — Task cancellation

Task cancellation must be distinct from transport request cancellation and process termination.

### TASK-06 — Durable history

Task transitions must remain attached to the originating logical execution even when the task outlives the connection that created it.

### TASK-07 — Task result

Final task results/errors must become part of the logical execution evidence and renderer pipeline.

---

## 16. MCP Apps / extension direction

Full MCP Apps hosting is not required to block the first useful tool-centric milestone, but it is part of the product direction.

### APP-01 — Extension discovery

The capability/server views must surface negotiated extensions generically rather than hard-code only Tasks.

### APP-02 — App metadata

When a capability advertises an MCP App/UI resource, the product must display the metadata and linkage even before full rendering support exists.

### APP-03 — Sandboxed rendering

A future complete Apps implementation must render remote UI content in the required sandboxed/consent-aware host environment rather than injecting arbitrary content into the Inspector DOM.

### APP-04 — App-initiated calls

App-originated tool calls must pass through the same auditable execution/authorization/capture model as direct operator calls.

---

## 17. Workspace requirements

### WS-01 — Durable workspace

Users can create, rename, save, duplicate, and delete workspaces.

### WS-02 — Multiple projections

A workspace supports at least Graph, Grid, and List projections over the same underlying nodes.

### WS-03 — Presentation states

Capability nodes support:

```text
collapsed
expanded
focus/fullscreen
```

### WS-04 — Multi-select

Nodes can be multi-selected for run, export, comparison, removal, and handoff actions.

### WS-05 — Layout persistence

The workspace preserves relevant grouping/layout/presentation state across reloads.

### WS-06 — Duplicate capability instances

The same capability can appear more than once with different execution configuration when useful.

### WS-07 — Cross-server grouping

Users can group/filter by server, capability type, status, tag, or execution state.

### WS-08 — Agent Run overlay

Observed Agent Runs can be opened in or overlaid onto a workspace without converting them into editable planned executions.

### WS-09 — Compact professional default

The default card surface should prioritize name, server, status, duration, selection, and concise metadata. Deep detail belongs in expansion/focus.

---

## 18. Expanded/focused inspection requirements

For a tool execution, the target local tabs are:

```text
Result
Parameters / Arguments
Docs
Protocol / Request
Trace
Source
History
Transport
Process     # when relevant
Logs        # when relevant
Agent Handoff
```

Not every tab must appear when no evidence exists.

### INSPECT-01 — Result maximization

The result surface itself must be independently maximizable without forcing the entire node context to remain visible.

### INSPECT-02 — Evidence availability

Tabs with unavailable evidence must state why it is unavailable rather than show fake placeholders in a completed product.

### INSPECT-03 — Cross-navigation

From an execution, users can navigate to server, capability definition, trace, source, history, Agent Run, and Investigation Packet where applicable.

---

## 19. Result rendering requirements

### RENDER-01 — Raw is always available

The original logical result payload must always be inspectable in a raw representation subject to redaction policy.

### RENDER-02 — JSON views

JSON results should support formatted, tree, and raw representations.

### RENDER-03 — Table inference

Structurally tabular arrays/objects should support a table view without losing access to the original JSON.

### RENDER-04 — TOON

TOON/compatible structured output should have structured/table/raw representations where feasible.

### RENDER-05 — Delimited/stream formats

CSV, TSV, NDJSON, and text should receive suitable rendering rather than being forced into JSON.

### RENDER-06 — MCP content blocks

Text, image, audio, resource links, embedded resources, and future supported MCP content block types must render appropriately.

### RENDER-07 — Large result virtualization

Large results must not require rendering every row/node at once.

### RENDER-08 — Renderer failure isolation

A renderer bug must not destroy the raw execution result or mark the MCP execution itself as failed.

---

## 20. Execution history and comparison requirements

### HIST-01 — Persist execution history

Where retention is enabled, executions survive page reload/restart according to deployment policy.

### HIST-02 — Immutable historical evidence

Editing current node arguments must not mutate past execution evidence.

### HIST-03 — Compare executions

Users can compare two or more executions of the same or related capabilities.

Comparison should cover where available:

- arguments;
- result/error;
- duration;
- protocol revision/era;
- server/source revision;
- trace differences;
- task/MRTR lifecycle;
- transport/process evidence.

### HIST-04 — Previous successful baseline

The product should make it easy to compare a failing execution to the previous successful execution.

### HIST-05 — Historical inspection without re-run

Opening history must not silently re-execute the operation.

### HIST-06 — Explicit rerun

A historical execution can be explicitly copied/rerun as a new execution.

---

## 21. Protocol and transport evidence requirements

### PROTO-01 — Exact protocol identity

Every execution should retain configured policy, negotiated era, and exact protocol revision where known.

### PROTO-02 — Capability/extension evidence

Negotiated client/server capabilities and extensions relevant to an execution must remain inspectable.

### PROTO-03 — Request/response evidence

The product must retain bounded request/response metadata sufficient to explain execution behavior.

### PROTO-04 — HTTP evidence

For Streamable HTTP, preserve relevant method/URL, MCP routing/version headers, response metadata, stream lifecycle, authentication/redaction metadata, and timing.

### PROTO-05 — `stdio` evidence

For `stdio`, preserve ordered MCP messages/direction, connection identity, process identity, negotiation, and timing.

### PROTO-06 — `stderr` separation

`stderr` is a log channel and must not automatically be classified as an MCP execution error.

### PROTO-07 — Malformed protocol visibility

Non-MCP protocol traffic, invalid framing, header/envelope mismatches, and parse/validation errors must be represented explicitly.

### PROTO-08 — Raw versus normalized

Normalized protocol evidence must never replace the ability to inspect bounded raw evidence.

### PROTO-09 — Cancellation provenance

The product must distinguish logical cancellation, HTTP stream cancellation, MCP cancellation signaling, Task cancellation, and local process termination.

---

## 22. Authentication and credential requirements

### AUTH-01 — Credential references

Server configurations should reference credentials/secrets rather than duplicate plaintext values into workspace/history storage.

### AUTH-02 — Common remote authentication

The product direction includes bearer/API-key/header-based remote credentials and standards-compliant MCP/OAuth flows where required.

### AUTH-03 — Modern OAuth behavior

For modern MCP, the client must follow the applicable issuer/resource authorization model rather than carry forward legacy assumptions that conflict with current protocol requirements.

### AUTH-04 — Mid-session recovery

Authentication failure/recovery during an active workflow must be representable without destroying unrelated workspace state.

### AUTH-05 — Required scopes

Where a server/capability advertises required scopes, the product should display them and explain authorization failures at the capability level.

### AUTH-06 — Secret redaction

Credentials, tokens, cookies, signed URLs, secret environment values, and configured sensitive fields must be redacted before persistence/export according to policy.

### AUTH-07 — No frontend-only authorization

Backend/runner authorization is authoritative. Hidden buttons are not a security boundary.

---

## 23. Local `stdio` and privileged runner requirements

ADR-0002 defines the accepted high-level decision. This PRD establishes the required user outcome.

### STDIO-01 — Inspector-originated process

A local user can configure and launch a real MCP server through Inspector X and use it like any other server.

### STDIO-02 — Transparent proxy

A local agent/application can configure Inspector X as a transparent `stdio` wrapper around the real MCP server so Inspector X observes calls not initiated from its own UI.

Conceptually:

```text
agent
  ↓ stdin/stdout
Inspector X stdio proxy
  ↓ stdin/stdout
actual MCP server
```

### STDIO-03 — Process versus call control

Cancelling one call must not implicitly kill the entire MCP server process.

### STDIO-04 — Process metadata

Privileged users can inspect redacted command/args, cwd, spawn/exit state, signal/exit code, and relevant logs.

### STDIO-05 — Bounded environment inheritance

The local runner must avoid indiscriminate persistence/display of the complete process environment.

### STDIO-06 — Hosted restriction

The future hosted public plane must not accept arbitrary process-spawn commands from users.

### STDIO-07 — Capture-session fallback

When exact Agent Run identity is unavailable, observed calls remain usable under a Capture Session rather than being falsely grouped into an Agent Run.

---

## 24. Agent Run observability requirements

ADR-0001 is authoritative for the accepted causal model. Product requirements are summarized here for whole-product completeness.

### AGENT-01 — Multiple observation points

The product can ingest/observe MCP activity from:

- Inspector-controlled client execution;
- Inspector gateway/proxy;
- local `stdio` proxy;
- instrumented server/runtime;
- imported OpenTelemetry-compatible traces/transcripts;
- later runtime-specific integrations.

### AGENT-02 — Causal model

Agent activity must be represented as causal/temporal relationships, not a fabricated total serial order.

### AGENT-03 — Agent Run views

A run supports:

```text
Timeline
Waterfall
Graph
List
Workspace overlay
```

### AGENT-04 — Concurrency visibility

Parallel calls must be visibly overlapping/sibling operations where evidence supports it.

### AGENT-05 — Logical call grouping

MRTR rounds and Task polling/transitions remain grouped under the originating logical capability operation.

### AGENT-06 — W3C trace correlation

When valid `traceparent`/`tracestate`/`baggage` exists, it is the preferred portable correlation source.

### AGENT-07 — Correlation provenance

The product must label whether relationships are runtime-confirmed, Inspector-identity-confirmed, protocol-correlated, inferred, partial, or unknown.

### AGENT-08 — Live and historical

Agent Runs should update live while active and remain inspectable historically without re-executing calls.

### AGENT-09 — Origin agnostic

The model must not require one specific agent framework.

### AGENT-10 — No chain-of-thought requirement

The product does not require, reconstruct, or claim access to private model reasoning.

---

## 25. Runtime trace requirements

### TRACE-01 — OpenTelemetry compatibility

Runtime tracing must interoperate with standard trace/span identity and W3C trace context where available.

### TRACE-02 — Execution correlation

Traces should be linkable to MCP executions and Agent Runs without making tracing mandatory for basic execution.

### TRACE-03 — Span tree

Users can inspect relevant parent/child spans, timing, status, and attributes subject to authorization/redaction.

### TRACE-04 — Critical path

Waterfall/trace views should help identify slow/failing paths and estimate critical path when reliable dependencies exist.

### TRACE-05 — Trace absence

A successful MCP execution without downstream telemetry remains a valid execution; the UI states that trace evidence is unavailable.

### TRACE-06 — Privileged access

Internal service traces may belong to the privileged intelligence plane even when the high-level MCP execution is user-visible.

---

## 26. Source intelligence requirements

### SRC-01 — Revision-aware indexing

Source intelligence must be tied to a repository/revision identity, preferably the exact deployed commit/revision.

### SRC-02 — No production filesystem dependency

Source inspection should not require arbitrary access to a production host filesystem when the same revision can be indexed from repository/CI artifacts.

### SRC-03 — Capability-to-source graph

The product should map an MCP capability to the relevant handler/symbol and downstream source dependencies.

### SRC-04 — Relevant snippet default

The default code view should show bounded relevant source rather than dump whole files.

### SRC-05 — Progressive code views

Users should be able to move through:

```text
Relevant snippet
Full symbol
Full file (lazy)
Dependencies
Dependents
Runtime trace
```

### SRC-06 — Runtime highlighting

Where trace/source correlation exists, the source view should visually distinguish runtime-confirmed symbols/lines from static-only relationships.

### SRC-07 — Static versus runtime provenance

Static dependency edges must not be presented as executed paths unless runtime evidence confirms them.

### SRC-08 — Revision uncertainty

If the deployed revision cannot be established, the product must not silently substitute repository `main`.

### SRC-09 — Multi-repository systems

One MCP execution may correlate to multiple repositories/services. The model must support that without flattening them into one source tree.

---

## 27. Investigation Packet requirements

### PACKET-01 — One execution

Users can create an Investigation Packet from one execution.

### PACKET-02 — Multiple executions

Users can create one bounded packet from selected executions.

### PACKET-03 — Agent Run

Users can create a packet from an Agent Run or causal subtree.

### PACKET-04 — Deterministic contents

Given the same retained evidence and packet options, generation should be deterministic enough for review/reproduction.

### PACKET-05 — Detail levels

At minimum:

```text
Compact
Investigation (default)
Exhaustive
```

### PACKET-06 — Output formats

Product direction includes Markdown and structured JSON; a downloadable bundle/artifact may include bounded attachments/source evidence.

### PACKET-07 — Required evidence

Where available, an Investigation Packet should include:

- server/capability identity;
- schema/docstring/description;
- exact arguments after redaction policy;
- result/error/raw evidence;
- timing/status;
- protocol era/revision;
- MRTR rounds;
- Task lifecycle;
- transport/process evidence;
- trace/span references;
- source graph/revision;
- bounded relevant snippets;
- comparison with a previous successful execution where requested;
- explicit redaction records;
- evidence availability/uncertainty;
- concise investigation instructions/context.

### PACKET-08 — No unbounded source dump by default

The default packet must select bounded evidence-driven source rather than attach complete repositories/files indiscriminately.

### PACKET-09 — Missing evidence honesty

The packet must explicitly state when source, trace, deployed revision, or other evidence is unavailable.

### PACKET-10 — Secret safety

Packet generation must apply backend redaction policy before export.

---

## 28. Persistence and retention requirements

### DATA-01 — Separate durable domains

Workspace configuration, server catalog, execution evidence, large payload artifacts, Agent Runs, source indexes, and trace data may have different retention/storage needs and must not be treated as one monolithic blob.

### DATA-02 — Configurable retention

Deployments/users must be able to configure execution/trace/capture retention within supported policies.

### DATA-03 — Large payload references

Large results/raw transcripts should use bounded artifact/reference storage where appropriate instead of being duplicated into every derived record.

### DATA-04 — Redaction before persistence

Configured secrets and sensitive fields must be redacted before durable evidence is persisted where policy requires it.

### DATA-05 — Delete/export

Users should be able to delete retained diagnostic data they control and export supported workspace/evidence artifacts.

### DATA-06 — Historical integrity

Persisted historical executions must remain immutable evidence; derived labels/annotations may be added without rewriting original evidence.

---

## 29. Security and trust-plane requirements

The product has two conceptual trust planes.

```text
Safe execution plane
  remote authorized MCP discovery/execution
  user-owned workspace/history/results

Privileged intelligence plane
  local stdio process spawning
  private source indexes/full files
  internal runtime traces
  deployment metadata
  privileged Investigation Packets
```

### SEC-01 — Backend enforcement

Authorization is enforced in backend/runner boundaries.

### SEC-02 — Least privilege

Connecting to an MCP server does not automatically grant access to private source repositories, internal traces, or local process execution.

### SEC-03 — Tenant isolation

A future hosted/multi-tenant deployment must isolate server configs, credentials, workspaces, execution evidence, Agent Runs, traces, source access, caches, and Investigation Packets.

### SEC-04 — Capture levels

Deployments must be able to choose bounded capture policies such as:

```text
metadata only
arguments + metadata
results + metadata
full diagnostic
```

### SEC-05 — Untrusted metadata

Trace baggage, MCP metadata, server-provided HTML/UI, logs, schemas, and result payloads are untrusted input.

### SEC-06 — App/UI sandboxing

Remote MCP App/UI content must be isolated according to the applicable extension security model.

### SEC-07 — Local execution policy

Privileged `stdio` execution should support policy mechanisms such as operator confirmation, executable allowlists, bounded environment inheritance, resource/time limits, and optional sandboxing.

---

## 30. Deployment modes and product packaging

### 30.1 Local-first workbench — V1 required

The complete V1 must be usable locally by one operator and capable of:

- connecting to remote Streamable HTTP MCP servers;
- launching/connecting to local `stdio` servers;
- running the web dashboard and local execution boundary;
- storing local catalog/workspaces/history;
- performing privileged source/trace integrations configured by the operator.

The exact packaging mechanism is an architecture/distribution decision.

### 30.2 Hybrid mode — product direction

A local privileged runner may communicate with a hosted/safe UI/control plane while keeping arbitrary process spawning and private source access local.

### 30.3 Hosted multi-tenant mode — later

A future hosted product may provide safe remote MCP execution, team workspaces, history, collaboration, and entitlements.

Hosted public infrastructure must not expose arbitrary `stdio` command execution.

---

## 31. CLI/TUI and automation direction

The web dashboard is the primary product surface, but the domain model should not make UI-only assumptions.

Later product direction may include:

- CLI server/capability discovery;
- scripted tool/resource/prompt execution;
- Investigation Packet generation;
- execution/history export;
- TUI inspection for terminal-heavy workflows;
- machine-readable output for CI/agents.

CLI/TUI are not required to block the complete V1 web workbench unless needed for local `stdio` proxying or operator bootstrap.

The `stdio-proxy` command is an exception: a local command-line entry point is required by the tracing/proxy design even if a general CLI is not yet complete.

---

## 32. UX quality requirements

### UX-01 — Professional visual density

The interface should resemble a professional observability/developer tool rather than a collection of colorful demo cards.

### UX-02 — Limited status color semantics

Color should communicate status/attention/selection, not decorate every metadata category.

### UX-03 — Keyboard accessibility

Core navigation, selection, expand/focus, run, and search workflows should be keyboard accessible.

### UX-04 — Responsive large surfaces

Focused result/source/trace views should use available viewport space efficiently.

### UX-05 — Empty/error states

Missing server, unavailable evidence, authorization failure, disconnected process, and empty workspace states must be actionable.

### UX-06 — No misleading “attached” labels

The UI must not display statements like “protocol evidence attached” unless the actual underlying evidence exists for that execution.

### UX-07 — Live status

Long-running executions/Tasks/Agent Runs must update incrementally without forcing a full-page refresh.

---

## 33. Non-functional requirements

### NFR-01 — Execution overhead

Inspection/capture must add bounded overhead and must not block unrelated executions on slow persistence/rendering.

### NFR-02 — Backpressure

Streaming/proxy paths must use bounded buffering/backpressure and avoid unbounded memory accumulation.

### NFR-03 — Large-run scalability

Timeline/List/Graph/Waterfall surfaces must use virtualization/reduction strategies for large Agent Runs or execution histories.

### NFR-04 — Failure isolation

Renderer, persistence, source-index, or optional telemetry failure should not automatically convert a successfully completed MCP call into a failed call.

### NFR-05 — Offline historical inspection

Retained execution evidence should remain inspectable even when the original MCP server is currently offline, subject to retention policy.

### NFR-06 — Deterministic tests

Protocol/execution behavior must be covered by deterministic unit/integration tests using real MCP test servers where wire semantics matter.

### NFR-07 — Security scanning

The existing repository security pipeline remains a required project baseline.

### NFR-08 — Browser responsiveness

Large JSON/table/source/trace views must not freeze the main UI thread through naive full rendering.

### NFR-09 — Version provenance

Execution/source/trace evidence must retain enough version/revision information to avoid accidental comparison of incompatible artifacts.

---

## 34. Current implementation baseline at PRD creation

This section is informative, not normative. It records the state against which the first PRD reconciliation should be performed.

As of 2026-08-19, the repository already contains:

- React/Vite web shell;
- Node/Hono gateway;
- product-owned `McpClientAdapter` seam;
- official MCP V2 SDK integration for real modern Streamable HTTP;
- `server/discover` negotiation evidence;
- real `tools/list` and `tools/call`;
- proven concurrent tool calls;
- cancellation path;
- `input_required` detection/manual MRTR state;
- Tasks extension advertisement/result detection;
- explicit legacy-era adapter/fallback path;
- official conformance harness integration for currently supported scenarios;
- built-in live demo MCP server wired to the web UI;
- Graph/Grid/List shell;
- collapsed/expanded/focus tool presentation;
- result classification foundation;
- Investigation Packet contracts;
- source graph contracts;
- trace/source correlation contracts;
- accepted ADR-0001 Agent Run Trace design;
- accepted ADR-0002 modern trace-context + local `stdio` design;
- CI/security/promotion-policy foundation.

The current baseline does **not** yet satisfy the complete product requirements in this PRD. In particular, current implementation should be treated as foundation rather than evidence that the following are complete:

- external server catalog/configuration;
- real dashboard parameter forms;
- dashboard Run Selected/Run All wiring;
- full MRTR round continuation;
- full Tasks lifecycle;
- resources/prompts workflows;
- OAuth/credential UX;
- execution persistence/history/compare;
- complete protocol/network transcript viewer;
- local `stdio` runner/proxy;
- source indexing/code viewer;
- runtime telemetry ingestion;
- Agent Run capture/views;
- live Investigation Packet assembly;
- production-ready renderer/large-result behavior;
- hosted/hybrid deployment.

---

## 35. Complete V1 scope

V1 is the first release that should be considered the complete standalone MCP Inspector X workbench rather than a protocol foundation/demo.

V1 is **local-first and single-operator capable**. Hosted multi-tenancy is not required for V1.

### 35.1 V1 required server/connection scope

V1 must support:

- saved remote Streamable HTTP server configurations;
- saved local `stdio` server configurations in the privileged local deployment;
- modern `2026-07-28` primary operation;
- explicit supported legacy compatibility;
- protocol/extension negotiation visibility;
- common credential/header references;
- standards-compliant OAuth flows needed for supported remote MCP servers;
- connection testing and actionable errors.

### 35.2 V1 required capability scope

V1 must provide real functional workflows for:

- tools;
- resources/resource templates;
- prompts.

V1 must surface negotiated extensions generically and provide full functional support for the Tasks extension used by supported operations.

Full MCP Apps rendering may ship after core V1 if extension metadata remains inspectable and the product does not architect itself into an Apps-incompatible design.

### 35.3 V1 required workspace/execution scope

V1 must support:

- durable workspaces;
- Graph/Grid/List;
- schema-driven configuration with raw fallback;
- duplicate differently-configured capability instances;
- Run One / Run Selected / Run All;
- bounded concurrency and failure isolation;
- cancellation/retry;
- complete MRTR lifecycle;
- complete Tasks lifecycle;
- rich result renderers;
- execution history and comparison;
- raw protocol/transport evidence.

### 35.4 V1 required diagnostic intelligence scope

V1 must include the differentiating diagnostic path, with graceful degradation when integrations are absent:

- Investigation Packet from real executions;
- protocol/request evidence;
- local `stdio` process/log evidence;
- Agent Run domain model and capture from Inspector/gateway/transparent `stdio` proxy;
- Timeline/Waterfall/Graph/List/Workspace Agent Run projections;
- W3C trace context preservation;
- OpenTelemetry trace ingestion/correlation when configured;
- revision-aware source graph/index ingestion when configured;
- Relevant snippet / Full symbol / Full file / Dependencies / Dependents / Runtime trace code views;
- exact deployed revision where resolvable;
- explicit unavailable/unknown/inferred states where not resolvable.

This means source/trace integrations are **optional to configure**, but the V1 product surfaces and contracts for them are real rather than placeholder tabs.

### 35.5 V1 security scope

V1 must have:

- secret redaction before durable diagnostic export;
- backend/runner authorization boundaries;
- privileged local process controls;
- clear local-versus-hosted process boundary;
- configurable diagnostic capture/retention;
- no arbitrary public hosted process spawn path.

---

## 36. V1 end-to-end acceptance scenarios

V1 is not complete until the following scenarios work with real MCP servers, not fixture-only UI.

### Scenario A — Multi-server daily workspace

1. Add at least one remote Streamable HTTP server.
2. Add at least one local `stdio` server.
3. Discover their tools/resources/prompts.
4. Add capabilities from several servers to one workspace.
5. Configure independent arguments.
6. Run selected independent tools concurrently.
7. Observe independent success/failure/status/duration.
8. Expand and focus results.
9. Inspect raw and normalized protocol evidence.
10. Reload the application and retain server/workspace/history state.

### Scenario B — Modern interactive execution

1. Execute an operation that returns `input_required`.
2. Inspect the requested input and first round evidence.
3. Provide a response.
4. Complete the same logical execution through the next round.
5. Inspect the full multi-round history.

### Scenario C — Task-backed operation

1. Execute a Task-capable operation.
2. Receive/display the task handle/lifecycle.
3. Poll/status-update it.
4. Handle task `input_required` if present.
5. Cancel or complete it.
6. Inspect the complete lifecycle under one logical execution.

### Scenario D — History/comparison

1. Run the same capability twice with a changed argument/server revision/result.
2. Compare arguments, result, duration, protocol/revision, and trace/source evidence where available.
3. Compare a failure against the previous successful execution.

### Scenario E — Investigation Packet

1. Select one or more real executions.
2. Generate the default Investigation Packet.
3. Verify deterministic inclusion of available protocol/result/timing evidence.
4. Verify bounded relevant source/trace evidence when configured.
5. Verify explicit missing-evidence statements when not configured.
6. Verify secrets are redacted with redaction records.

### Scenario F — Agent/local `stdio` observation

1. Configure an external local agent/application to launch an MCP server through the Inspector `stdio-proxy`.
2. Perform several MCP calls outside the Inspector UI.
3. See those calls arrive live under a Capture Session or Agent Run.
4. Preserve concurrency/causality where evidence allows.
5. Inspect protocol messages and `stderr` logs separately.
6. Generate an Investigation Packet from the observed run/calls.

### Scenario G — Trace/source correlation

1. Execute a capability against a server instrumented with compatible trace/source metadata.
2. Open the execution Trace tab.
3. Navigate to the runtime-confirmed source symbols.
4. See the exact repository/revision when known.
5. Open Relevant snippet, Full symbol, and Full file lazily.
6. Distinguish runtime-confirmed from static-only source edges.

### Scenario H — Resource/prompt capability coverage

1. Browse/read a real resource/resource template.
2. Execute a real prompt with arguments.
3. Inspect their raw/structured results.
4. Store them in the same execution/history model without pretending they are tools.

---

## 37. V1 release gates

A V1 release requires:

- documented supported MCP eras/revisions;
- applicable official conformance scenarios passing for claimed behavior;
- typecheck/tests/build green;
- security scanning baseline green or explicitly waived with durable justification;
- real HTTP and `stdio` integration tests;
- real MRTR integration test;
- real Tasks lifecycle integration test where supported by official fixtures/servers;
- persistence migration/compatibility strategy for stored local data;
- secret-redaction tests;
- failure-isolation tests;
- large-result/large-run UI validation;
- end-to-end smoke test against packaged/distributed product, not only source-tree development mode;
- documentation for adding a remote server, adding a local `stdio` server, running the dashboard, and configuring agent tracing.

No V1 claim should rely on placeholder controls or tabs whose required behavior is not wired.

---

## 38. Milestone strategy

The implementation roadmap may choose smaller internal milestones, but product progress should roll up to these outcomes.

### M0 — Foundation — substantially landed

Protocol adapter, execution/workspace contracts, demo UI, CI/conformance/security foundations.

### M1 — Usable Inspector

Goal: an operator can connect real servers and use the dashboard productively.

Includes:

- external server management;
- remote HTTP + local `stdio` execution;
- schema-driven forms;
- Run One/Selected/All;
- real result surfaces;
- persistence/history;
- resource/prompt basics;
- protocol evidence.

### M2 — Complete modern execution

Includes:

- full MRTR;
- full Tasks;
- modern auth/OAuth;
- extension negotiation visibility;
- robust legacy boundaries;
- expanded conformance coverage.

### M3 — Diagnostic intelligence

Includes:

- Investigation Packets from real evidence;
- trace ingestion;
- source indexing/revision mapping;
- combined trace/source/code views;
- execution comparison improvements.

### M4 — Agent observability

Includes:

- AgentRun persistence/model;
- gateway/Inspector capture;
- transparent `stdio` proxy;
- W3C correlation;
- Timeline/Waterfall/Graph/List/Workspace projections;
- agent-run Investigation Packets.

### M5 — V1 hardening and release

Includes:

- complete acceptance scenarios;
- packaging/distribution;
- performance/large-data hardening;
- security/retention UX;
- documentation;
- conformance/release evidence.

Milestones may overlap when architecture makes parallel work safe. They are product outcomes, not mandatory sprint boundaries.

---

## 39. Post-V1 product direction

The following are valid later directions but must not distract from V1 completion.

### 39.1 Hosted / team product

- accounts/organizations;
- shared server catalogs/workspaces;
- RBAC/entitlements;
- team execution history;
- shared Investigation Packets;
- hosted safe-plane remote execution;
- local privileged runner pairing;
- retention/governance policies.

### 39.2 MCP Apps

- complete sandboxed Apps host;
- App-specific protocol/permission inspection;
- App-initiated call tracing;
- UI resource debugging.

### 39.3 CLI/TUI

- full capability coverage;
- scriptable execution;
- CI use;
- agent-friendly machine output;
- terminal-native trace/history inspection.

### 39.4 Evals / regression suites

Saved executions/workspaces may later become reproducible MCP regression/evaluation suites, but Inspector X must not become a generic workflow orchestrator to obtain this feature.

### 39.5 Extension/plugin ecosystem

Allow third parties to add renderers, source adapters, trace backends, auth providers, or domain views behind stable extension seams.

### 39.6 Collaboration and annotations

Human comments, bookmarks, labels, shared investigations, and links to external issue trackers may be added after core evidence integrity is solved.

### 39.7 Deployment/release comparison

Compare the same capability across environments/revisions and surface behavioral/protocol/source differences.

---

## 40. Explicit non-goals

MCP Inspector X is not intended to become:

- a general-purpose agent runtime;
- a replacement for model reasoning/orchestration frameworks;
- a private chain-of-thought recorder;
- a generic arbitrary DAG/workflow engine;
- a full APM replacement;
- a full SIEM/log management platform;
- a generic REST/GraphQL API client unrelated to MCP;
- an unrestricted remote shell/process execution service;
- a source-code host or IDE replacement;
- a system that fabricates causality/source execution when telemetry is absent;
- a system that silently mutates or replays historical MCP calls merely because history is opened.

---

## 41. Product success criteria

The product is succeeding when an operator can use it as the default place to understand a non-trivial MCP system rather than opening separate tools for every layer.

Qualitative success indicators:

- multi-server workflows feel normal rather than exceptional;
- an operator can move from “this MCP call failed” to protocol/result/trace/source evidence without manual context reconstruction;
- external agent MCP traffic can be observed without forcing the agent to become Inspector-specific;
- Investigation Packets are sufficient for a coding agent to begin diagnosis without the operator manually assembling evidence;
- historical executions remain trustworthy and comparable;
- protocol era/transport/extension complexity is visible when needed but does not dominate basic workflows;
- the UI remains usable for both one tool and many concurrent tools.

Suggested measurable product targets for V1 validation:

- time from clean install to first real tool call: under 10 minutes with documentation;
- one workspace can safely execute at least 10 independent tool calls concurrently subject to server limits;
- a workspace/Agent Run with at least 1,000 historical call rows remains navigable through virtualization/filtering;
- large structured results do not require full DOM materialization to inspect;
- no known code path persists configured secrets into Investigation Packets without redaction policy;
- every visible historical execution identifies whether protocol revision, source revision, trace, and Agent Run correlation are known, unavailable, partial, or inferred.

These are product validation targets, not hard protocol limits.

---

## 42. Documentation requirements

V1 documentation must include at minimum:

- quick start;
- local development and packaged start;
- add a remote Streamable HTTP server;
- add a local `stdio` server;
- credential/auth configuration;
- server catalog/workspace persistence;
- schema-driven tool execution;
- Run Selected/Run All;
- MRTR;
- Tasks;
- resource and prompt inspection;
- execution history/comparison;
- protocol/transport evidence;
- Investigation Packets;
- source/trace configuration;
- Agent Run tracing;
- `stdio-proxy` configuration for local agents;
- security/redaction/retention behavior;
- exact MCP protocol/conformance support matrix.

Documentation examples must distinguish modern MCP `2026-07-28` behavior from legacy behavior when relevant.

---

## 43. Product governance

### 43.1 Requirement IDs

Stable IDs in this PRD should be referenced by ADRs, issues, implementation PRs, and completion ledgers where practical.

### 43.2 Amendments

Material product-scope changes should update this PRD in the same change set or before implementation begins.

### 43.3 ADR relationship

An ADR may refine or constrain a requirement but should not silently remove a product requirement.

### 43.4 Current implementation reconciliation

After this PRD is accepted, the repository should produce a one-time complete reconciliation:

```text
PRD requirement
  → already landed
  → partially landed
  → missing
  → intentionally deferred post-V1
```

That reconciliation should become the input to the next comprehensive residual architecture ADR and roadmap/issues.

---

## 44. Architecture questions intentionally left for ADR-0003

The next comprehensive architecture decision should derive from this PRD and ADR-0001/0002. It should resolve, at minimum, the following questions without re-litigating accepted product intent.

### 44.1 Persistence topology

- Where and how are server catalog, workspaces, executions, Agent Runs, artifacts, and user settings persisted locally?
- What schema/version/migration guarantees exist?
- What changes for later hosted mode?

### 44.2 Gateway/runner boundaries

- What process owns remote HTTP connections?
- What process owns local `stdio` spawning/proxying?
- How do browser/UI, gateway, and privileged runner communicate?
- Which APIs are safe to expose remotely?

### 44.3 Credential storage

- How are local credentials/secrets referenced and encrypted/stored?
- What is persisted versus environment/keychain/secret-manager backed?
- How is OAuth state shared across execution surfaces?

### 44.4 Execution/event model

- What canonical persisted event model supports normal calls, MRTR, Tasks, Agent Runs, protocol messages, trace linkage, cancellation, and history?
- How are live updates streamed to the UI?

### 44.5 Protocol evidence transport wrapper

- How is raw request/response/message evidence captured around the official SDK without coupling product packages to Inspector upstream internals?
- How are modern HTTP headers and `stdio` messages normalized while retaining raw evidence?

### 44.6 Full capability adapter

- How are tools, resources, prompts, extensions, and future capability types represented behind product-owned interfaces?
- Where does JSON Schema form generation live?

### 44.7 Auth architecture

- How are OAuth, bearer/header credentials, issuer binding, scope recovery, and mid-session authorization handled consistently across HTTP/web/CLI/local runner?

### 44.8 Source index architecture

- How are repositories/revisions indexed?
- How is deployed revision resolved?
- What source graph representation/storage is used?
- How are snippets/full symbols/full files fetched lazily?

### 44.9 Trace ingestion architecture

- Which OTel ingestion path/backend is supported first?
- How are traces correlated to executions and source?
- What is stored locally versus referenced externally?

### 44.10 Agent Run capture architecture

- How do Inspector-originated calls, HTTP gateway traffic, transparent `stdio` traffic, and imported telemetry converge into one event model?
- How are Capture Sessions promoted/correlated to Agent Runs when evidence arrives later?

### 44.11 Investigation Packet assembly

- What bounded evidence-selection algorithm chooses source/trace/protocol excerpts?
- How are packet profiles/versioning/redaction represented?

### 44.12 Renderer architecture

- What renderer registry/plugin model supports JSON/table/TOON/text/media/large artifacts and later third-party renderers?

### 44.13 Apps/extension host boundary

- How will sandboxed MCP Apps be hosted and permissioned without weakening the Inspector trust model?

### 44.14 Deployment and packaging

- How is the complete local-first product packaged and launched?
- How will a future local privileged runner pair with a hosted safe plane?

### 44.15 Conformance/release matrix

- How are supported protocol revisions/features mapped to official conformance tests and release gates?
- What constitutes “supported,” “ready,” and “conformant” in durable project automation?

ADR-0003 should produce a coherent complete V1 architecture, not a collection of unrelated incremental decisions.

---

## 45. Canonical product direction

MCP Inspector X will become a local-first, general-purpose MCP workbench in which an operator can connect multiple real MCP servers, inspect all major server capabilities, configure and execute operations concurrently, preserve rich protocol and transport evidence, inspect history, correlate runtime behavior to exact source revisions, observe MCP calls made by agents/applications, and export deterministic Investigation Packets for diagnosis.

The product differentiator is not merely “another MCP request UI.” It is the combination:

```text
multi-server workspace
+ real modern MCP execution
+ concurrent inspection
+ protocol/transport evidence
+ history/comparison
+ local stdio visibility
+ Agent Run observability
+ runtime/source correlation
+ bounded agent handoff
```

The next architectural work must use this PRD as its product contract and close the remaining gap from the current executable foundation to the complete V1 defined above.
