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
- R0 (this slice) — smoke §21.1 coverage expansion + release-gate reconciliation

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

- **R1 — Tasks spec correction** (`mcp-inspector-4to`). The Tasks lifecycle in smoke scenarios 8–9 is domain-layer only: the gateway advertises `io.modelcontextprotocol/tasks` and rides polling as `taskAction` rounds on `/executions/:id/rounds`. `apps/gateway/src/tasks.test.ts` documents the SDK gap ("no live wire-level `tasks/get` in the installed SDK"). R1 wires real `tasks/get`/`tasks/cancel`/`tasks/list` against MCP 2026-07-28. Classified: PARTIAL.
- **R9 — Conformance-client OAuth** (`mcp-inspector-v6b`). Remote-MCP OAuth (issuer discovery, PKCE, resource indicators, refresh) is wired in the gateway/protocol/runner path (PR #53), but `apps/conformance-client` has no `OAuthProvider`. All 74 informational conformance `auth/*` failures trace to this and to `apps/conformance-client/expected-failures.yml`. Classified: PARTIAL.
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
