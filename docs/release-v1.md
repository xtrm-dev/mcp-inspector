# MCP Inspector X — V1 release notes

This document is the V1 release-readiness record required by [PRD §37](product/PRD.md) ("V1 release gates"). It is written from **Phase N** — packaging, supervised smoke, and official conformance evidence — the final slice of the [V1 completion campaign](https://github.com/xtrm-dev/mcp-inspector/issues/23).

## What this slice adds

- `npm run package` — bundles the privileged runner, the gateway, and the conformance client to single-file JS (esbuild), builds the web SPA (`vite build`), stages a real npm package (`dependencies: { "better-sqlite3" }`, `bin: mcp-inspector-x`), `npm pack`s it, and writes a sha256 checksum next to the tarball (`dist-package/*.tgz` + `.sha256` + `package-info.json`).
- `npm run smoke` — extracts the tarball, `npm install --omit=dev`s it exactly like an `npx` consumer would, boots the packaged supervisor, and runs a real HTTP scenario suite against it: health check, add-a-server, tool call, workspace run, Investigation Packet export, and packaged web UI reachability. Signal-handled (`SIGINT`/`SIGTERM`) so the supervisor and its runner/gateway children never leak, even mid-`npm install`.
- `npm run conformance` — runs the official `@modelcontextprotocol/conformance` harness against the **packaged** conformance client (`dist-package/stage/conformance-client.mjs`, not `tsx src/index.ts`), and writes evidence to `conformance/evidence/v1-<date>.json`.
- Gateway now optionally serves the built web SPA as a static site (`MIX_WEB_DIST` env, packaged-only — source/dev mode is unaffected) so the packaged product is a single running gateway process serving both the API and the UI.
- README quickstart: `npx @xtrm-dev/mcp-inspector-x@latest`.

## Conformance evidence

See [`conformance/evidence/`](../conformance/evidence/) for the dated JSON evidence file. Summary as of this slice:

- **MCP revision exercised:** `2026-07-28`
- **Required (gate):** `tools_call` — 2/2 checks passed (`tool-add-numbers`, `wire-schema-valid`). This is the scenario CI's required job (`.github/workflows/conformance.yml`) gates on.
- **Informational (non-blocking):** full `--requirements 2026-07-28` sweep — 22 passed / 74 failed. Failures are concentrated in `auth/*` and `sep-2322-client-request-state` scenarios: MCP Inspector X does not wire an `OAuthProvider` yet (that lands in the OAuth slice), so every auth-flow scenario fails by design. This mirrors the existing CI scoreboard job's scope, and the itemized expectation baseline lives at [`apps/conformance-client/expected-failures.yml`](../apps/conformance-client/expected-failures.yml).
- **Packaged artifact checksum:** recorded in the evidence file (`packagedArtifact.sha256`), computed over the exact tarball `npm run package` produced for that run.

## What this slice does NOT cover

Packaging + smoke + conformance wiring is intentionally scoped to what the integration base (`3f0d36d`, Phase B slice 2) implements. It does not integrate:

- MRTR / manual-mode rounds, cancel/retry, Tasks lifecycle (Phase E/G slices)
- OAuth / remote-server auth (Phase I slice 2) — this is why the informational conformance sweep fails every `auth/*` scenario
- stdio-proxy agent observation (Phase L slice 3)
- source indexer, renderer virtualization, and the full Web UI (Phase F/M/E slices)

Those land on their own PR branches and get their own conformance-scope expansion once merged; the smoke harness's scenario list (`scripts/smoke.mjs`, `SCENARIOS` array) is a plain plugin array so post-integration scenarios (MRTR round, cancel/retry, stdio server add, packet-with-agent-run) append without touching the harness itself.

## Release-gate checklist (PRD §37)

| Gate | Status |
|---|---|
| Documented supported MCP eras/revisions | done — `2026-07-28` modern era, legacy fallback (`packages/protocol`) |
| Applicable official conformance scenarios passing | done for the implemented client scope (`tools_call`); broader scope tracked, not yet green (auth) |
| typecheck/tests/build green | done (`npm run typecheck && npm test && npm run build`) |
| Security scanning baseline | out of scope for this slice — see `.github/workflows/{gitleaks,osv-scanner,semgrep}.yml` |
| Real HTTP and stdio integration tests | HTTP: done (existing gateway test suite). stdio: proven at the runner layer (`apps/gateway/src/stdio-mcp.test.ts`); not yet in the packaged smoke suite (stdio server add is a scenario-plugin candidate once Phase L slice 3 merges) |
| Real MRTR / Tasks integration test | deferred — lands with the MRTR/Tasks slices, out of this base |
| Persistence migration/compatibility strategy | existing (`packages/storage` migrations) |
| Secret-redaction tests | existing (`apps/gateway/src/credentials.test.ts`, packet redaction in `packages/investigation`) |
| Failure-isolation tests | existing (executor per-node failure isolation) |
| Large-result/large-run UI validation | deferred to renderer-virtualization slice |
| **End-to-end smoke against packaged product** | **done — this slice** (`npm run smoke`) |
| Docs: add remote server, add stdio server, run dashboard, configure agent tracing | quickstart done (this slice); full walkthrough follows once the Web UI slice merges |

## Reproducing this evidence

```bash
npm install
npm run package
npm run smoke
npm run conformance
```
