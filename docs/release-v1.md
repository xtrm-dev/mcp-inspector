# MCP Inspector X — V1 release notes

This document is the V1 release-readiness record required by [PRD §37](product/PRD.md) ("V1 release gates"). It is the reconciled ledger against the current integrated `dev` tree after the V1 residual campaign wave (PRs #24–#54) and the R0 residual reconciliation (this section).

## Integrated V1 slices (as of dev)

- Phase A slice 1 — durable control-plane substrate (PR #24)
- Phase B slice 1 — privileged local runner + authenticated IPC + dev supervisor (PR #26)
- Phase B slice 2 — MCP-over-stdio via privileged runner (PR #38)
- Phase F slice 1 — renderer registry (tree/table/TOON/CSV/TSV/NDJSON/text/content-block) (PR #37)
- Phase F slice 2 — renderer virtualization + artifact-backed large payloads (PR #40)
- Phase L slice 2 — trace ↔ Execution/AgentRun correlation + timeline (PR #49)
- Phase L slice 3 — stdio-proxy capture for external-agent MCP observation (PR #39)
- Phase M slice 3 — source indexer: capability → handler/symbol mapping (PR #48)
- Phase E slice 2B — cancel + retry + resource/prompt dispatch in `/run` (PR #50)
- Phase G — MRTR persistence + Tasks lifecycle (domain-layer) (PR #51)
- Phase E slice 3 — schema-driven forms + full `/api/v1/*` SPA (PR #54)
- Phase I slice 2 — remote MCP OAuth + OS keychain + secrets (PR #53)
- Phase N — packaging + supervised smoke + official conformance evidence (PR #52)
- R0 — smoke §21.1 coverage expansion + release-gate reconciliation (PR #56)
- R0 runner-wiring fix — packaged gateway wires the runner, defaults loopback bind, plus researcher memo (PR #57)
- R-headers — custom-header credentials (X-API-Key and arbitrary auth headers) for real API-key MCP servers (this slice)

## Packaging & harnesses

- `npm run package` — bundles the privileged runner, the gateway, and the conformance client to single-file JS (esbuild), builds the web SPA (`vite build`), stages a real npm package (`dependencies: { "better-sqlite3" }`, `bin: mcp-inspector-x`), `npm pack`s it, and writes a sha256 checksum next to the tarball (`dist-package/*.tgz` + `.sha256` + `package-info.json`).
- `npm run smoke` — extracts the tarball, `npm install --omit=dev`s it exactly like an `npx` consumer would, boots the packaged supervisor, and runs a real HTTP scenario suite against it. Signal-handled (`SIGINT`/`SIGTERM`) so the supervisor and its runner/gateway children never leak, even mid-`npm install`.
- `npm run conformance` — runs the official `@modelcontextprotocol/conformance` harness against the **packaged** conformance client (`dist-package/stage/conformance-client.mjs`, not `tsx src/index.ts`), and writes evidence to `conformance/evidence/v1-<date>.json`.
- Gateway serves the built web SPA as a static site (`MIX_WEB_DIST` env, packaged-only) so the packaged product is a single running gateway process serving both the API and the UI.
- README quickstart: `npx @xtrm-dev/mcp-inspector-x@latest`.

## Packaged smoke scenarios (`npm run smoke`)

The `SCENARIOS` plugin array in `scripts/smoke.mjs` runs against the extracted tarball:

| # | Scenario | PRD §36 mapping |
|---|---|---|
| 1 | `health` | operational readiness |
| 2 | `add server (second binding to the demo MCP endpoint)` | A (multi-server workspace) |
| 3 | `tool call (add_numbers on the demo server)` | A |
| 4 | `workspace run (create workspace + node, run it, verify the result)` | A |
| 5 | `packet export (build an Investigation Packet from the tool-call execution)` | E (Investigation Packet) |
| 6 | `history/comparison (compare two add_numbers executions)` | D (History/comparison) |
| 7 | `MRTR round (interactive_greet: input_required → input_response, same executionId)` | B (Modern interactive execution) |
| 8 | `Tasks lifecycle (long_running_task: create → poll → complete under one executionId)` | C (Task-backed operation) — **domain-layer**, see R1 residual |
| 9 | `Tasks cancel (long_running_task: create → cancel mid-run)` | C (cancel branch) |
| 10 | `runner wiring (stdio-proxy capture session open + list + close)` | STDIO / runner boot proof (regression guard for bug `mcp-inspector-68e`) |
| 11 | `web UI reachable (packaged SPA served by the gateway)` | UI/frontend |

Last-known result: 11/11 pass after the R0-runner-wiring fix landed (`apps/gateway/src/index.ts` now reads `MIX_RUNNER_SOCKET`/`MIX_RUNNER_TOKEN_PATH`, constructs a `RunnerClient`, and passes it to `createServerManager` + `buildGatewayApp`). The packaged gateway also defaults its HTTP bind to `127.0.0.1` (`MIX_HOST` override) so a packaged tarball run on a host with a public IP no longer silently exposes the API — see bug `mcp-inspector-vus`.

## Conformance evidence

See [`conformance/evidence/`](../conformance/evidence/) for the dated JSON evidence file. Summary as of this slice:

- **MCP revision exercised:** `2026-07-28`
- **Required (gate):** `tools_call` — 2/2 checks passed (`tool-add-numbers`, `wire-schema-valid`). This is the scenario CI's required job (`.github/workflows/conformance.yml`) gates on.
- **Informational (non-blocking):** full `--requirements 2026-07-28` sweep — 22 passed / 74 failed. Failures are concentrated in `auth/*` and `sep-2322-client-request-state` scenarios: MCP Inspector X does not wire an `OAuthProvider` yet (that lands in the OAuth slice), so every auth-flow scenario fails by design. This mirrors the existing CI scoreboard job's scope, and the itemized expectation baseline lives at [`apps/conformance-client/expected-failures.yml`](../apps/conformance-client/expected-failures.yml).
- **Packaged artifact checksum:** recorded in the evidence file (`packagedArtifact.sha256`), computed over the exact tarball `npm run package` produced for that run.

## Known residuals — tracked, NOT covered by this slice

### Protocol correctness

- **R1 — Tasks spec correction** (issue #60). CLEAN. Slice 1 (PR #66) added `getTask` / `updateTask` / `cancelTask` on `McpClientAdapter` and wired the gateway. Slice 2 (PR #68) made the wire real end-to-end via a raw-fetch seam that bypasses `Client.request` (SDK #2598 client-side rejection at the negotiated-version gate), with a strict-server assertion proving exact wire methods land and historical `tasks/list` / `tasks/result` are never emitted. Packaged smoke expansion for the real seam still to land.
- **R2 — Modern negotiation hardening** (issue #61). CLEAN. Slice 1 (PR #70) regression guard: `policy: "auto"` against a modern-only server classifies modern (SDK #2722 protection). Slice 2 (PR #71) negative guard: `policy: "modern"` against a legacy-only server must not silently downgrade.
- **P0 / P1 PRD-ADR wording** (issue #62). DONE. P0 (PR #67) sharpened `server/discover`, MRTR retry semantics, Tasks state machine, `pollIntervalMs` ownership, expanded conformance caveat. P1 (PR #72) sharpened CAP-07 + ADR-0003 §13.3 modern `subscriptions/listen` language.
- **R9 — Conformance-client OAuth** (issue #63). PARTIAL. Slice 1 (PR #73) adds Bearer + custom-header credential surfaces so the harness exercises OAuth-required / API-key-gated scenarios through the same descriptor path production servers use. See the operator runbook below for exercising an OAuth-protected server without runtime code-flow. Slice 2 (dynamic OAuth adapter — `DynamicOAuthProvider` in `apps/conformance-client/src/oauth-provider.ts`) IMPLEMENTED; requires the operator to mint a `refresh_token` once (browser code-flow, out of band) and set the `MCP_CONFORMANCE_OAUTH_*` env surface — every subsequent conformance run is unattended, with the provider exchanging refresh_token → access_token via the issuer's token endpoint, caching until near-expiry, and re-minting on demand. Slice 1's pre-minted `MCP_CONFORMANCE_BEARER_TOKEN` path is preserved as fallback (no regression). Slice 3 (operator-in-the-loop E2E evidence against a real MCP OAuth issuer, exercising the full PKCE consent flow through a real browser) remains — external-dependency-blocked pending a hosted MCP OAuth reference server.

### Canonical workspace-first UX reconstruction — R-UX (issue #64)

Restores the workspace-first shell over the existing `/api/v1` backend, per the recovered V2 mockup and PRD §6 IA. Progress:

- **UX-0** (PR #65). DONE. Recovered V2 mockup persisted at `docs/design/mockups/2026-08-16-mercury-inspector-v2-reference.html` verbatim + `docs/design/README.md` (design authority hierarchy).
- **UX-1** (PR #69). DONE. Workspace-first shell — topbar, sidebar (`Workspace | Capabilities | Executions | Agent Runs | Source / Runtime | Servers | Settings`), workspace canvas region wired to real `/api/v1/workspaces/*`, right-hand detail pane placeholder. Default landing is now Workspace, not Servers.
- **UX-2** — Grid + List capability card projections; collapsed / expanded / focus states; shared local inspection tabs. IN PROGRESS. Sibling `mcp-inspector-xt-pi-ux2-cards` (Codex `gpt-5.6-sol`, worktree `.xtrm/worktrees/mcp-inspector-xt-pi-ux2-cards`, branch `xt/ux2-cards`) has scaffold on disk (`WorkspaceProjections.tsx` + `workspace-cards.test.tsx`); correction pass in flight.
- **UX-3** — Graph projection + persisted layout. HAND-ROLL SCAFFOLD PENDING. Sibling `mcp-inspector-xt-pi-ux3-graph` completed library evaluation: `@xyflow/react` at 52 kB gzip fails the 200 kB app-budget constraint; hand-roll approved. Sibling holds writes until UX-2 lands.
- **UX-4** (PR #75). DONE. Cross-server Capability Catalog + Add-to-workspace modal. Search + kind filter + server chips + show-disconnected toggle. Reusable modal ready for UX-2 per-node Add affordance.
- **UX-5 slice 1** (PR #77). DONE. Structured execution comparison view — replaces the raw-`<pre>` dump antipattern per dispatch §20. Slice 2 (shared inspector promotion + full tab set) and slice 3 (first-class "compare failed with last successful" affordance) remain.
- **UX-6 slice 1** (PR #78). DONE. Agent Run Timeline projection + projection picker (List / Timeline). Slice 2 adds Waterfall / Graph / Workspace projections.
- **UX-7 slice 1** (PR #79). DONE. Source / Runtime / Combined mode toggle. Slice 2 (Runtime graph rendering) and slice 3 (Combined overlay + code viewer modes) remain.
- **UX-8** (PR #76). DONE. Investigation Packet will-include preview: shows per-tier evidence composition across selection with explicit "n/a for selection" markers rather than silent drops.

### Full-suite verification as of this ledger update

- `npm test` — **289 pass, 3 skipped, 55 test files** (0 regressions across 15 merged coordinator PRs).
- `npm run build` — green.
- `npm run typecheck` — green.
- **F — stdio server-add smoke scenario**. `apps/gateway/src/stdio-mcp.test.ts` proves stdio at the runner layer, and `apps/gateway/src/capture-*.test.ts` proves the stdio-proxy capture path. Neither yet runs against the packaged product because the packaged tarball ships no `stdio` demo binary; the operator playbook covers it end-to-end.
- **G — trace/source packaged scenario**. Storage seam, timeline overlay, revision → handler/symbol mapping are wired; a packaged smoke scenario against a deterministic fixture repository/revision is not yet in `SCENARIOS`.
- **Large-result virtualization** — renderer registry + artifact paging are wired (PR #40); a packaged smoke assertion of virtualized rendering under threshold boundaries is not yet in `SCENARIOS`.

## Release-gate checklist (PRD §37)

| Gate | Status | Evidence |
|---|---|---|
| Documented supported MCP eras/revisions | PASS | `2026-07-28` modern era, legacy fallback (`packages/protocol`) |
| Applicable official conformance scenarios passing (claimed behavior) | PARTIAL | Required scenario `tools_call` — 2/2 checks pass (`conformance/evidence/v1-*.json`). Informational sweep — 22 pass / 74 fail, all traceable to R9 conformance-client OAuth gap. |
| typecheck/tests/build green | PASS | `npm run typecheck && npm test && npm run build`; 266 tests pass |
| Security scanning baseline | UNKNOWN | `.github/workflows/{gitleaks,osv-scanner,semgrep}.yml` exist; last CI status verified per-PR, not summarized here |
| Real HTTP and stdio integration tests | PASS | HTTP: PASS (packaged smoke + gateway test suite). stdio: PASS at the runner layer (`apps/gateway/src/stdio-mcp.test.ts`, `capture-*.test.ts`); packaged smoke scenario 10 proves runner wiring end-to-end. Real stdio-server-add via `POST /api/v1/servers {transport:"stdio"}` follows the operator runbook. |
| Real MRTR integration test | PASS | Unit: `apps/gateway/src/mrtr.test.ts`. Packaged smoke: scenario 7 (this document). |
| Real Tasks lifecycle integration test | PARTIAL | Unit: `apps/gateway/src/tasks.test.ts`. Packaged smoke: scenarios 8–9. Wire-level `tasks/get` NOT yet exercised — see R1. |
| Persistence migration/compatibility strategy | PASS | `packages/storage` migrations |
| Secret-redaction tests | PASS | `apps/gateway/src/credentials.test.ts`, `apps/gateway/src/secrets.test.ts`, packet redaction in `packages/investigation` |
| Failure-isolation tests | PASS | Executor per-node failure isolation (`apps/gateway/src/executor.ts` + tests) |
| Large-result/large-run UI validation | PARTIAL | Renderer virtualization + artifact paging shipped (PR #40); packaged smoke assertion of threshold boundaries not yet added |
| **End-to-end smoke against packaged product** | PASS | `npm run smoke` — 10/10 scenarios pass |
| Docs: add remote server, add stdio server, run dashboard, configure agent tracing | PARTIAL | Quickstart done; operator walkthrough for stdio + OAuth follows R9 |

## Reproducing this evidence

```bash
npm install
npm run package
npm run smoke
npm run conformance
```

## R9 — Conformance-client OAuth operator runbook

Slice 1 (PR #73) accepts a pre-minted OAuth access token via env,
exercising an OAuth resource-server end-to-end without a browser
redirect during the harness run. The operator mints the token out-of-band
against the OAuth issuer; the harness pipes it to the resource server
through the same descriptor path production servers use.

```bash
# 1. Operator mints an access token against the OAuth issuer.
#    Method depends on the issuer (client credentials, device code, or
#    a captured refresh cycle — MCP Inspector X does not prescribe).
#    Store the token in a shell variable; do not echo, do not log.
export MCP_CONFORMANCE_BEARER_TOKEN="$(read-token-from-secure-source)"

# 2. Optional: pin the protocol version.
export MCP_CONFORMANCE_PROTOCOL_VERSION="2026-07-28"

# 3. Run the conformance harness against the OAuth-protected resource
#    server. The harness invokes the packaged conformance client with
#    the URL as last argv; the env var is picked up by
#    apps/conformance-client/src/index.ts and set on the descriptor
#    as `bearerToken`, sent as `Authorization: Bearer <token>` on every
#    request through the SDK Streamable HTTP transport's auth provider.
npm run conformance -- --url=https://mcp.example.com/  # illustrative
```

For API-key-gated servers (non-Bearer auth headers), use
`MCP_CONFORMANCE_CUSTOM_HEADERS` — a JSON object of `{ header: value }`
that merges into `descriptor.customHeaders`:

```bash
export MCP_CONFORMANCE_CUSTOM_HEADERS='{"X-API-Key": "'"$MIX_APIKEY"'"}'
```

### Evidence capture

Preserve the following per run under `docs/evidence/YYYY-MM-DD-<issuer-slug>/`:

- `conformance-run.json` — the harness's own evidence file.
- `env-context.txt` — the exact env var names supplied (values REDACTED).
- `gateway.log` — the gateway process log for the run (secrets
  already scrubbed by `SecretsRegistry.known()`).
- `sha256sums.txt` — of the packaged `.tgz` under test.

Never commit the token itself. Redact any log line the harness might
have written it to before storing evidence.

### Slice 2 (implemented; requires operator-mint refresh_token once)

Dynamic OAuth refresh-token adapter — `DynamicOAuthProvider` in
`apps/conformance-client/src/oauth-provider.ts`. Env-configured issuer /
client / redirect. The operator performs the browser code-flow ONCE to
obtain a `refresh_token`; every subsequent conformance run is unattended
because the provider exchanges refresh_token → access_token via the
issuer's token endpoint (RFC 6749 §6), caches until near-expiry, and
re-mints on demand. Errors are surfaced structurally as
`DynamicOAuthError` with `kind: "http" | "network" | "malformed"` (and
`status` for HTTP failures).

When the dynamic env surface is fully populated, it takes precedence
over slice 1's pre-minted bearer token. When it is NOT populated, the
harness falls back to slice 1 behavior with no change.

```bash
# One-time (operator, out of band): mint a refresh_token via the issuer's
# authorization code flow (any OAuth client tool — no MIX code path).
export MCP_CONFORMANCE_OAUTH_ISSUER="https://issuer.example"
export MCP_CONFORMANCE_OAUTH_CLIENT_ID="mcp-inspector-x-conformance"
export MCP_CONFORMANCE_OAUTH_CLIENT_SECRET="…"           # optional; omit for public clients
export MCP_CONFORMANCE_OAUTH_REDIRECT_URI="http://127.0.0.1:0/cb"
export MCP_CONFORMANCE_OAUTH_SCOPES="mcp:read mcp:call"  # optional
export MCP_CONFORMANCE_OAUTH_REFRESH_TOKEN="$(read-refresh-token-from-secure-source)"

# Every subsequent conformance run is unattended:
npm run conformance -- --url=https://mcp.example.com/    # illustrative
```

The token endpoint is discovered per RFC 8414
(`{issuer}/.well-known/oauth-authorization-server`) on the first
`getAccessToken()` and cached for the process lifetime; if discovery
returns non-2xx, the adapter falls back to `{issuer}/token`.

### Slice 3 (pending, same issue #63)

Operator-in-the-loop remote-MCP OAuth E2E — real browser redirect,
consent screen, PKCE, refresh cycle, all captured as durable evidence.
Requires a real MCP OAuth issuer + a scripted operator step.

## Residual reconciliation — post-#87 (2026-08-29)

Audit `/tmp/mcpdispatch.md` established that `dev` was NOT
promotion-ready after #87 and that CI was RED. Streams reopened:

- **Gate 0 — CI GREEN (PR #88 merged)** — typecheck breaks in
  `apps/gateway/src/demo-mcp.ts` (`typeof msg` narrowing to `never`)
  and `apps/web/src/components/AgentRunWaterfall.tsx`
  (`ex.createdAt` not on `ExecutionRecord`) repaired.
- **Stream A dispatched (branch `wave/r1-r2-protocol-final`)** —
  R1.3 real `resultType:"task"` extension + `pollIntervalMs`
  scheduler + `tasks/update` input-required lifecycle E2E; R2.2
  byte-precise `server/discover` envelope fixture. Reopens #60, #61.
- **Stream B dispatched (branch `wave/ws-residual-ux`)** — stdio
  server config UI (Scenario A step 2 unblock), real workspace edges
  (drops `edges={[]}`), 4 bulk workspace actions
  (Export/Compare/Remove/Handoff). Reopens #64.

### Wave landings

| PR | Slice | Status |
|----|-------|--------|
| #88 | Gate 0 — CI typecheck fix | merged |
| #89 | Stream F — R9 slice 2 dynamic OAuth adapter (#63) | merged |
| #90 | Infra — osv-scanner linked-worktree fix | merged |
| #91 | Stream D — shared inspector on Executions + AgentRun Graph/Workspace + Source/Logs tabs (#64) | merged |
| #92 | Stream B — stdio config UI + real workspace edges + 4 bulk actions (#64) | merged |
| #93 | Stream A — R1 real Task extension + `pollIntervalMs` scheduler + input-required + R2 envelope fixture (#60, #61) | merged |
| #94 | Stream E — Source Runtime + Combined graph + code viewer (5 sub-views) (#64) | merged |
| #95 | Stream C — product-owned HTTP wire recorder (raw request/response + Authorization redaction) (#23) | merged |

### Integrated dev verification snapshot

- `npm run typecheck` — green across every package.
- `npm run test` — 66 test files, 333 tests pass, 3 skipped, 0 fail.
- `npm run build` — green.
- CI on dev — required checks green (verify, semgrep, osv, gitleaks,
  socket, conformance-core, promotion-policy).

### Trackers reconciled

- #1 — closed as superseded by #23.
- #60 R1 — closed by #93.
- #61 R2 — closed by #93.
- #62 P0 — closed prior.
- #64 R-UX — closed by #91 + #92 + #94.
- #63 R9 — slice 2 landed (#89); slice 3 (real MCP OAuth issuer +
  operator step) remains external-dep-blocked.

### Outstanding external-dependency work

- **#63 R9 slice 3** — real MCP OAuth issuer + scripted operator
  step (browser + PKCE + refresh cycle E2E). Runbook in the
  "OAuth qualification" section above.
- **Packaged final smoke rerun + PRD §36 A–H** on packaged current
  dev — script exists; needs a full end-to-end run against real MCP
  servers and durable evidence capture.
- **`dev → main` promotion PR** — requires explicit user
  authorization to open; every gate above is satisfied.

### Packaged verification (2026-08-29)

- `npm run package` — build clean, artifact
  `dist-package/xtrm-dev-mcp-inspector-x-1.0.0-v1.tgz`
  sha256 `e98134d8c2922675b4780d4ec7b2ce35cd9b14c3f254b6b8be9a9a82bb4a44d3`.
- `npm run smoke` — **11 / 11 scenarios pass**: add server, tool call,
  workspace run, packet export, history/comparison, MRTR round
  (`interactive_greet` input_required → input_response, same
  executionId), Tasks lifecycle (`long_running_task` create → poll →
  complete under one executionId), Tasks cancel (mid-run), runner
  wiring (stdio-proxy), packaged SPA served by gateway. Evidence:
  smoke stdout.
- `npm run conformance` — **required scope: PASS**
  (`required.passed: true`). Informational scoreboard shows the
  itemized `apps/conformance-client/expected-failures.yml` baseline
  (resources/prompts/tasks/MRTR client-side + all OAuth extensions
  are not-yet-implemented by the conformance-client at this slice —
  per the ADR §29.4 caveat, NOT a regression). Evidence:
  `conformance/evidence/v1-2026-08-29.json`.
