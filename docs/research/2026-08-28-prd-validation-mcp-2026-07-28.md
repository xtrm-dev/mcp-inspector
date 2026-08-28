# R-researcher memo — MCP Inspector X PRD / dispatch validation

**Retrieved:** 2026-08-28
**Protocol target:** MCP `2026-07-28`
**Dispatch reference:** `mercuryintelligence/program` commit [`4a2c264a8c65e24cebc96681c8c60717b38cc4d6`](https://github.com/mercuryintelligence/program/commit/4a2c264a8c65e24cebc96681c8c60717b38cc4d6)
**Compared locally:** `docs/product/PRD.md`, ADR-0001, ADR-0002, ADR-0003, current `packages/protocol`, gateway tests and conformance client.

## 1. Executive verdict

The PRD and ADRs have the right product direction and are substantially aligned with the released `2026-07-28` wire model. They correctly separate transport from protocol era, preserve opaque MRTR state, model Tasks as negotiated/optional, and keep local `stdio` privilege separate from remote HTTP.

The dispatch must nevertheless treat two things as hard boundaries rather than ordinary implementation work:

1. **Modern Tasks are an SDK gap.** The TypeScript SDK v2 has no native `io.modelcontextprotocol/tasks` path. Its modern codec rejects `resultType: "task"`; `tasks/get` and `tasks/cancel` collide with historical core method names and are rejected before custom handlers. The official Inspector currently works around this with raw-wire/interception code.
2. **Conformance is not a single authoritative green/red oracle yet.** The current harness is `0.2.0-alpha.11`, still models `2026-07-28` as draft, excludes Tasks from the frozen scored requirements, and has open schema, issuer-context and coverage issues. Pin versions, retain a local deterministic suite, and label upstream limitations explicitly.

**Recommendation:** proceed, but split protocol-sensitive work into small slices with explicit raw-wire tests and an upstream-blocker ledger. Do not claim whole-product conformance from the current sweep.

## 2. Fresh source snapshot

| Source | HEAD inspected | HEAD commit date / relevant fact |
|---|---|---|
| Spec | [`d8fdc88`](https://github.com/modelcontextprotocol/modelcontextprotocol/tree/d8fdc88fb970313247d8a180ac1ec3f6a10a8885) | 2026-08-26; contains final `docs/specification/2026-07-28` and schema |
| TypeScript SDK | [`7b781ed`](https://github.com/modelcontextprotocol/typescript-sdk/tree/7b781ed4e25355a25d15974f3c76de81299694ed) | 2026-08-25; v2 packages and modern-era support docs |
| Conformance | [`74edef3`](https://github.com/modelcontextprotocol/conformance/tree/74edef34d674f563537be8c6587cebaa58e830ca) | 2026-08-17; package `0.2.0-alpha.11` |
| Official Inspector | [`edf54f5`](https://github.com/modelcontextprotocol/inspector/tree/edf54f5dec5f1fcd6772074f11238d087dd7a1e2) | 2026-08-26; package `2.4.0` |
| Tasks extension (referenced by released spec) | [`0d0a6bd`](https://github.com/modelcontextprotocol/ext-tasks/tree/0d0a6bd4c258b35caa3c810a1dd506cf105b1501) | 2026-08-27; stable `2026-07-28` extension schema |

## 3. Spec facts that must drive the plan

- **Modern is stateless and per-request.** There is no `initialize` handshake, protocol-level HTTP session, `Mcp-Session-Id`, HTTP GET stream, SSE resumability, or `tasks/list`/`tasks/result` in the modern core. Every request carries `_meta.io.modelcontextprotocol/protocolVersion` and `clientCapabilities`; `server/discover` is a required server method but optional for a client to call. [Spec architecture](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/d8fdc88fb970313247d8a180ac1ec3f6a10a8885/docs/specification/2026-07-28/basic/index.mdx), [versioning](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/d8fdc88fb970313247d8a180ac1ec3f6a10a8885/docs/specification/2026-07-28/basic/versioning.mdx), [discover](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/d8fdc88fb970313247d8a180ac1ec3f6a10a8885/docs/specification/2026-07-28/server/discover.mdx), [changelog](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/d8fdc88fb970313247d8a180ac1ec3f6a10a8885/docs/specification/2026-07-28/changelog.mdx).
- **MRTR is a new request/retry shape, not a server-initiated RPC.** `input_required` may include `inputRequests` and/or opaque `requestState`; the client must echo `requestState` byte-for-byte, must not inspect it, and retries with a new JSON-RPC id. `inputResponses` are round-scoped. [MRTR](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/d8fdc88fb970313247d8a180ac1ec3f6a10a8885/docs/specification/2026-07-28/basic/patterns/mrtr.mdx).
- **HTTP headers are compliance behavior.** Every modern POST requires `MCP-Protocol-Version` matching body metadata and `Mcp-Method`; `Mcp-Name` is required for name/URI operations. `x-mcp-header` is optional for servers but clients must validate/reject invalid annotations and mirror valid values as `Mcp-Param-*`. [Streamable HTTP](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/d8fdc88fb970313247d8a180ac1ec3f6a10a8885/docs/specification/2026-07-28/basic/transports/streamable-http.mdx).
- **Cancellation is transport-specific.** Modern HTTP cancellation is closing the request SSE stream; `stdio` must send `notifications/cancelled`. A broken modern HTTP stream loses the request and requires a new request/id; it is not resumable. [stdio](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/d8fdc88fb970313247d8a180ac1ec3f6a10a8885/docs/specification/2026-07-28/basic/transports/stdio.mdx), [HTTP](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/d8fdc88fb970313247d8a180ac1ec3f6a10a8885/docs/specification/2026-07-28/basic/transports/streamable-http.mdx), [subscriptions](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/d8fdc88fb970313247d8a180ac1ec3f6a10a8885/docs/specification/2026-07-28/basic/patterns/subscriptions.mdx).
- **Tasks are an optional extension, not core.** `io.modelcontextprotocol/tasks` supports `tools/call` task augmentation, `tasks/get`, `tasks/update`, and `tasks/cancel`; it removes `tasks/list` and blocking `tasks/result`. The server decides per request, may return either a normal result or `resultType: "task"`, and must durably create the task before returning its handle. [Released Tasks extension](https://github.com/modelcontextprotocol/ext-tasks/blob/0d0a6bd4c258b35caa3c810a1dd506cf105b1501/specification/2026-07-28/tasks.md), [stable schema](https://github.com/modelcontextprotocol/ext-tasks/blob/0d0a6bd4c258b35caa3c810a1dd506cf105b1501/schema/2026-07-28/spec.types.ts).
- **Tasks notifications use subscriptions.** The extension adds task notification filtering to `subscriptions/listen`; this is separate from core list-change filters. [Tasks schema](https://github.com/modelcontextprotocol/ext-tasks/blob/0d0a6bd4c258b35caa3c810a1dd506cf105b1501/schema/2026-07-28/spec.types.ts).
- **OAuth is HTTP-oriented.** HTTP clients must perform protected-resource metadata and issuer-aware authorization-server discovery; credentials are bound to the issuing `issuer`. STDIO should use host/environment credentials rather than MCP HTTP OAuth. [Authorization](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/d8fdc88fb970313247d8a180ac1ec3f6a10a8885/docs/specification/2026-07-28/basic/authorization/index.mdx).

## 4. PRD / ADR reconciliation

### Correct and retain

- PRD §§6, 14–16, 21–24 and ADR-0002 correctly separate `transport` and `protocolEra`, make MRTR/Tasks logical-call children, preserve raw evidence, and keep `stdio` process identity distinct from Agent Run identity.
- PRD AUTH-03 / ADR-0003 §18 correctly call for resource/audience binding, issuer validation and per-issuer credential isolation.
- ADR-0003 §10 correctly keeps `packages/protocol` as the only product-facing SDK seam and says not to import Inspector internals as a runtime dependency.
- ADR-0003 §29 correctly separates `ready`, `supported` and `conformant` claims.

### Amend or sharpen before implementation

| Priority | Local statement | Fresh evidence / required correction |
|---|---|---|
| P0 | PRD §6.4 presents `server/discover` as “where applicable”. | For modern servers `server/discover` **MUST** be implemented. The client may skip calling it. Say “required server method; optional client probe.” |
| P0 | PRD MRTR-04 says “resume/retry semantics” and ADR-0003 §16 says “retry the same logical operation”. | The logical execution is retained, but the wire retry is a **new independent JSON-RPC request with a new id**. Never describe it as resuming an HTTP request or reusing a protocol session. |
| P0 | ADR-0003 §17 state machine begins `created → polling/working`. | `created` is an internal persistence state only. The extension wire statuses are `working`, `input_required`, `completed`, `failed`, `cancelled`; do not emit `created` as a Task status. |
| P0 | ADR-0003 §17.4 says poll interval semantics are exposed “by the extension/SDK where available”. | The extension explicitly provides `pollIntervalMs` and clients SHOULD honor it. SDK support is unavailable, so the product scheduler must own this behavior. |
| P1 | PRD §§6.4, CAP-07 and ADR-0003 §13 mention list changes/subscriptions generically. | Name modern `subscriptions/listen`, acknowledgement, `subscriptionId`, reconnect-by-re-listen and per-request notification streams. Do not carry forward `resources/subscribe`, HTTP GET, or SSE resumability into modern claims. |
| P1 | PRD §6.4 lists `Mcp-Param-*` as general modern routing metadata. | Qualify it: only valid `x-mcp-header` annotations generate these headers; invalid annotations exclude the tool from `tools/list`; `Mcp-Name` for Tasks methods is defined by the Tasks extension as `taskId`. |
| P1 | PRD/ADR say Tasks are negotiated, but the current adapter advertises Tasks and stops at evidence. | This is a real implementation gap, not a supported capability. Do not advertise a completed Tasks workflow until the raw extension path and strict-server header tests pass. |
| P1 | ADR-0003 §40 calls current conformance “evolving” but cites only #425/#426. | Update the caveat with current #424 (task schema), #422 (issuer context), #418 (unobserved raw traffic), #439/#440 (MRTR fixtures), and #461 (bundled server resultType). |

No fundamental product contradiction was found. The P0 items are protocol-language corrections that prevent incorrect implementation/test contracts.

## 5. SDK findings and BLOCKED-UPSTREAM ledger

### Confirmed public support

SDK v2 exposes `Client`, `StreamableHTTPClientTransport`, `StdioClientTransport` (stdio subpath), `versionNegotiation`, `getProtocolEra()`, `getNegotiatedProtocolVersion()`, MRTR auto/manual controls, list pagination/cache controls, `McpSubscription`, and an `OAuthClientProvider` with issuer-aware persistence context. Modern behavior is **opt-in**: the default client mode remains legacy. [Protocol-version guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/7b781ed4e25355a25d15974f3c76de81299694ed/docs/protocol-versions.md), [2026 migration guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/7b781ed4e25355a25d15974f3c76de81299694ed/docs/migration/support-2026-07-28.md), [OAuth API](https://github.com/modelcontextprotocol/typescript-sdk/blob/7b781ed4e25355a25d15974f3c76de81299694ed/packages/client/src/client/auth.ts).

### Blockers / realities

| Severity | Reality | Consequence for Inspector X |
|---|---|---|
| **P0** | [SDK #2637](https://github.com/modelcontextprotocol/typescript-sdk/issues/2637): modern `resultType: "task"` is rejected by the client codec; public tool callback types do not include `CreateTaskResult`. | Use a product-owned raw transport/interceptor and explicit extension schemas, or wait for SDK support. Do not cast this away at the adapter boundary. |
| **P0** | [SDK #2598](https://github.com/modelcontextprotocol/typescript-sdk/issues/2598): modern `tasks/get` and `tasks/cancel` are classified as historical spec methods and rejected with `-32601` before custom handlers; `tasks/update` does not collide and is reachable. | Server-side SDK `createMcpHandler` cannot be the sole modern Tasks implementation. Use a pre-dispatch extension route or another SDK release. |
| **P0** | [SDK #2569](https://github.com/modelcontextprotocol/typescript-sdk/issues/2569): `subscriptions/listen` filter/event types are closed to extension notifications, blocking `notifications/tasks`. | Treat task status notifications as unavailable; poll explicitly. Do not claim subscription-backed Tasks updates. |
| **P0** | [SDK #2722](https://github.com/modelcontextprotocol/typescript-sdk/issues/2722): probe can silently drop a spec-conformant discovery envelope with top-level `resultType`/`_meta` and misclassify a modern server as legacy. | Pin and test the exact SDK; add a discovery probe regression fixture. This affects modern connection establishment before product code runs. |
| **P1** | [SDK #2704](https://github.com/modelcontextprotocol/typescript-sdk/issues/2704): stateless server misuse can surface as an opaque 500 through the Node wrapper. | Keep per-request server construction in fixtures and package smoke; classify opaque 500 as an upstream/runtime failure, not protocol success. |
| **P1** | [SDK #2507](https://github.com/modelcontextprotocol/typescript-sdk/issues/2507): no public high-level MCP operation interceptor seam. | Raw protocol evidence must be captured at the transport boundary; avoid private SDK registries except in a quarantined compatibility shim. |
| **P1** | [SDK #2650](https://github.com/modelcontextprotocol/typescript-sdk/issues/2650) and [#2641](https://github.com/modelcontextprotocol/typescript-sdk/issues/2641): modern listen stream lifecycle has open edge cases. | Bound listen cleanup and test ack timeout, disconnect and empty-honored-filter cases. |

The SDK's current docs explicitly state that Tasks support is absent and that debugging tools should not default to `versionNegotiation: 'auto'` because the stdio probe can add latency and pollute transcripts. The local `packages/protocol` comments correctly identify this gap, but the current adapter's unconditional Tasks advertisement should be changed to a deliberate capability/policy decision.

## 6. Official Inspector HEAD: useful reference and remaining upstream defects

At Inspector [`edf54f5`](https://github.com/modelcontextprotocol/inspector/tree/edf54f5dec5f1fcd6772074f11238d087dd7a1e2), modern Tasks are implemented as a compatibility layer, not by SDK-native support:

- [`core/mcp/modernTaskSchemas.ts`](https://github.com/modelcontextprotocol/inspector/blob/edf54f5dec5f1fcd6772074f11238d087dd7a1e2/core/mcp/modernTaskSchemas.ts) redeclares permissive modern schemas, maps `ttlMs`/`pollIntervalMs`, and documents the SDK codec limitation.
- [`core/mcp/inspectorClient.ts`](https://github.com/modelcontextprotocol/inspector/blob/edf54f5dec5f1fcd6772074f11238d087dd7a1e2/core/mcp/inspectorClient.ts) sends extension methods through a raw-wire path with explicit schemas and rewrites task handles around the SDK codec.
- The real integration test [`inspectorClient-tasks-era.test.ts`](https://github.com/modelcontextprotocol/inspector/blob/edf54f5dec5f1fcd6772074f11238d087dd7a1e2/clients/web/src/test/integration/mcp/inspectorClient-tasks-era.test.ts) is the right behavioral template: server-directed creation without a client hint, `tasks/get`, `tasks/update` for input, no `tasks/list`/`tasks/result`, unsolicited handles, cancellation and round caps.

However, Inspector still has open issues that matter to this dispatch:

- [Inspector #1917](https://github.com/modelcontextprotocol/inspector/issues/1917): raw modern Tasks requests omit required `Mcp-Name: taskId` over Streamable HTTP; strict servers reject polls/updates/cancels with `-32020`.
- [Inspector #2140](https://github.com/modelcontextprotocol/inspector/issues/2140): web Cancel sends `notifications/cancelled` for HTTP instead of aborting the request SSE stream.

Therefore upstream Inspector code is a reference for tests and compatibility tactics, not evidence that the implementation is spec-complete.

## 7. Conformance reality

The required-set CLI lookup was run with `@modelcontextprotocol/conformance@0.2.0-alpha.11`:

```text
2026-07-28: 69 frozen required scenarios
  server: 36
  client: 33
  not scored: 16 extension + 1 added-after-release + 3 pending
```

The frozen requirements file is [`requirements/2026-07-28.yaml`](https://github.com/modelcontextprotocol/conformance/blob/74edef34d674f563537be8c6587cebaa58e830ca/requirements/2026-07-28.yaml). Tasks are run for visibility but all ten Tasks scenarios are `not_scored: extension`; three core scenarios are `pending`. The harness README says `--requirements` is the only way to run the frozen release profile and that each scenario must run at its revision's wire version. [Harness README](https://github.com/modelcontextprotocol/conformance/blob/74edef34d674f563537be8c6587cebaa58e830ca/README.md).

Current upstream issues materially affecting interpretation:

- [#426](https://github.com/modelcontextprotocol/conformance/issues/426): final `2026-07-28` is still treated as draft/latest remains `2025-11-25`; default Tier runs can score the wrong profile.
- [#424](https://github.com/modelcontextprotocol/conformance/issues/424): core wire-schema validation rejects valid extension `resultType: "task"` envelopes.
- [#422](https://github.com/modelcontextprotocol/conformance/issues/422): pre-registration fixture omits issuer context required by final authorization-server binding.
- [#418](https://github.com/modelcontextprotocol/conformance/issues/418): raw HTTP/inline mocks bypass wire-schema instrumentation.
- [#439](https://github.com/modelcontextprotocol/conformance/issues/439) and [#440](https://github.com/modelcontextprotocol/conformance/issues/440): MRTR scenario/fixture defects remain relevant to input-required scoring.
- [#461](https://github.com/modelcontextprotocol/conformance/issues/461): bundled everything-server can omit `resultType` on streamed tool responses.

The local repository is narrower still: `apps/conformance-client/src/index.ts` implements only `initialize` and `tools_call`, and `scripts/conformance.mjs` deliberately treats the full sweep as informational. The ADR's required machine-readable `conformance/support-matrix.yml` is not present in this worktree. That absence should be a tracked release artifact gap, not silently inferred from the expected-failures file.

## 8. Refined R1–R10 residual slice list

This is the recommended refinement of the residual dispatch, ordered by protocol risk and dependency. It supersedes broad “implement feature” wording with observable acceptance evidence.

| Slice | Scope / acceptance evidence | Dependencies / status |
|---|---|---|
| **R1 — Modern Tasks wire path** | Add extension schemas and a raw request seam for `tools/call` task handles, `tasks/get`, `tasks/update`, `tasks/cancel`; send `Mcp-Method` + `Mcp-Name: taskId`; reject `tasks/list`/`tasks/result`; persist one logical execution; real fixture + strict-header test. | Existing bead `mcp-inspector-4to`; blocked by SDK #2637/#2598 and Inspector #1917 unless compatibility shim is used. |
| **R2 — Modern negotiation hardening** | Test `server/discover`, pinned/auto/legacy policies, top-level result envelope, unsupported-version retry, probe timeout/401/5xx, stdio sibling behavior, and cached verdict freshness. | SDK #2722 is a release blocker; must precede modern claims. |
| **R3 — MRTR/manual driver** | Real `tools/call`, `prompts/get`, and `resources/read` `input_required` flows; opaque byte-faithful state; new request IDs; per-round evidence; max-round and tamper failures; no auto-fulfilment hidden from UI. | R2; keep request state unparsed by product code. Conformance #439/#440 require fixture caveats. |
| **R4 — HTTP/stdio evidence + cancellation** | Capture raw envelope/headers/stream lifecycle; separate stderr; modern HTTP abort vs stdio cancellation notification; malformed stdout/header mismatch; bounded backpressure. | R1–R3; Inspector #2140 is a useful negative test. |
| **R5 — Capability catalog and subscriptions** | `server/discover`, paginated tools/resources/prompts/templates, cache provenance, `subscriptions/listen` ack/id/relisten, invalid `x-mcp-header` exclusion, extension map display. | R2; SDK #2569 means task notifications remain polling-only until fixed. |
| **R6 — OAuth/auth conformance** | Wire issuer-aware `OAuthProvider` into `apps/conformance-client`; provider storage keyed by issuer; real remote HTTP OAuth E2E; SSRF/issuer confusion/redaction negatives; separate stdio credential policy. | Existing bead `mcp-inspector-v6b`; conformance #422 is harness-blocked, not a reason to omit local tests. |
| **R7 — Durable execution/history** | One typed execution model for tool/resource/prompt/MRTR/Tasks; immutable evidence, retry lineage, compare failure vs prior success, restart retention and artifact refs. | Existing persistence foundation; R1/R3 evidence shapes must stabilize first. |
| **R8 — AgentRun / stdio proxy** | Inspector/gateway/transparent proxy observation, CaptureSession fallback, causal/concurrency provenance, process/log evidence, no fabricated run identity. | R4 + stable event IDs; ADR-0001/0002. |
| **R9 — Source/trace/packet intelligence** | OTLP/W3C correlation, exact revision or explicit unknown, static-vs-runtime edges, bounded deterministic redacted packets from real executions. | R7/R8; integrations are optional but surfaces must be real, not placeholder tabs. |
| **R10 — Packaged release and conformance ledger** | Expand packaged smoke to scenarios A–H, add `conformance/support-matrix.yml`, pin harness+SDK commits, regenerate evidence, migration/security/performance gates, and publish scoped claim language. | All prior slices; current `docs/release-v1.md` and conformance client are stale/narrow. |

### Dispatch guardrails

- A slice is not “done” because the SDK type-checks. Each protocol slice needs at least one real wire fixture and raw transcript assertion.
- Keep SDK/Inspector workarounds behind `packages/protocol`; delete them only after upstream fixes are released and tested.
- Treat conformance `not_scored`, pending, skipped and expected-failure outcomes as separate statuses.
- Do not count an upstream harness failure as an Inspector failure, but do not use it to waive a local deterministic test.
- Do not advertise the Tasks extension on paths that cannot actually handle either a normal result or `resultType: "task"`.

## 9. Bottom line for dispatch

Dispatch R1 only with the raw-wire compatibility design and strict `Mcp-Name` requirements in its contract. Dispatch R2 before broad modern support claims. Dispatch R6 as a local implementation task plus a separate harness-blocker note. Hold the final V1 claim until R10 regenerates a versioned support matrix and packaged Scenario C evidence.
