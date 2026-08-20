# Changelog

Format loosely follows [Keep a Changelog](https://keepachangelog.com/). Dates are UTC.

## [1.0.0-v1] — Unreleased (draft)

V1 completion campaign (GH #23 / #5). Full details: [`docs/release-v1.md`](docs/release-v1.md).

### Added

- **Packaging + distribution**: `npm run package` produces an installable tarball (bundled runner + gateway + web SPA, checksum, `bin: mcp-inspector-x`); `npx @xtrm-dev/mcp-inspector-x@latest` is the documented install path.
- **Supervised smoke suite**: `npm run smoke` boots the packaged product from its tarball and exercises add-server, tool-call, workspace-run, and packet-export end-to-end over real HTTP, with signal-handled teardown (no orphan processes).
- **Official MCP conformance evidence**: `npm run conformance` runs the `@modelcontextprotocol/conformance` harness against the packaged (bundled, not source-tree) conformance client; dated JSON evidence lands in `conformance/evidence/`.
- Live `@modelcontextprotocol/client` v2 SDK adapter: modern era (`2026-07-28`) and legacy-era compatibility, concurrent execution, cancellation, MRTR/`input_required` manual mode, Tasks extension advertisement.
- Durable control plane: server catalog CRUD, connect/disconnect/test-connection, persistent workspaces + workspace-node CRUD, execution history + structural comparison.
- Resources + prompts capability model; renderer registry (tree/table/TOON/CSV/TSV/NDJSON/text/content-block) and renderer virtualization for large payloads.
- Credential refs + env/OS/session providers with central secret redaction.
- Investigation Packets built from real execution evidence, wired end-to-end.
- Agent Run + capture-session substrate; trace ingestion and trace↔AgentRun/Execution correlation with timeline overlay.
- Privileged local runner (authenticated UDS IPC) with MCP-over-stdio spawn path; stdio-proxy capture for external-agent MCP observation.
- Capability → handler/symbol source indexer.
- Schema-driven web UI forms; full SPA migration onto `/api/v1/*`.

### Known gaps at this slice

- OAuth / remote-server auth is not wired (`apps/conformance-client/expected-failures.yml` enumerates every auth conformance scenario that fails as a result).
- The packaged smoke suite covers what the integration base implements (add server, tool call, workspace run, packet export); MRTR-round and cancel/retry scenarios are scenario-plugin candidates once those slices are integrated onto this branch's mainline.

[1.0.0-v1]: https://github.com/xtrm-dev/mcp-inspector/compare/main...dev
