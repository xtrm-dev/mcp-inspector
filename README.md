# MCP Inspector X

A visual, multi-tool Model Context Protocol inspector for capability discovery, concurrent execution, rich result rendering, source/runtime inspection, and deterministic agent handoff.

> Independent project. This repository is not the official Model Context Protocol Inspector maintained by the MCP project.

## Status

Early implementation. The protocol target is MCP `2026-07-28` modern era, with explicit legacy compatibility where required.

Canonical product requirements and V1 completion scope: [`docs/product/PRD.md`](docs/product/PRD.md).

## Install / quickstart

```bash
npx @xtrm-dev/mcp-inspector-x@latest
```

This starts the local supervisor (privileged runner + gateway + web UI), seeds a built-in demo MCP server, and opens `http://127.0.0.1:6275/` in your browser. Requires Node.js `>=22.19.0`. Data (SQLite + artifacts) lives under `~/.mcp-inspector-x` by default — override with `MIX_DATA_DIR`. Stop with `Ctrl-C`; the supervisor drains the runner and gateway cleanly.

Useful environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `6275` | Gateway/web HTTP port |
| `MIX_DATA_DIR` | `~/.mcp-inspector-x` | SQLite DB, artifacts, runner socket/token |
| `MIX_NO_OPEN` | unset | Set to `1` to skip auto-opening a browser |

### Building/running from source

```bash
git clone https://github.com/xtrm-dev/mcp-inspector.git
cd mcp-inspector
npm install
npm run dev          # runner + gateway + web dev server, all in one supervisor
```

### Packaging a distributable build

```bash
npm run package       # bundles runner+gateway+web into a tarball under dist-package/
npm run smoke          # boots the packaged tarball and exercises it end-to-end over real HTTP
npm run conformance   # runs the official MCP conformance harness against the packaged client, writes conformance/evidence/
```

`npm run package` produces `dist-package/<name>-<version>.tgz` plus a `.sha256` checksum. Extracting it and running `npm install --omit=dev && node bin.mjs` inside is exactly what `npx` does on a user's machine — that's also what `npm run smoke` automates as its validation.

## Branch model

`dev` is the default development/integration branch. `main` is stable/latest only.

```text
feature/*
   ↓ pull request
  dev
   ↓ promotion pull request
 main
```

Normal feature/fix pull requests target `dev`. Changes reach `main` only through a verified `dev → main` promotion, except an explicitly labeled emergency hotfix. See [`docs/branching.md`](docs/branching.md).

## Product direction

MCP Inspector X is designed around a multi-tool workspace rather than a single request form:

- discover and inspect multiple MCP servers and capabilities;
- configure every executable capability independently;
- run one, selected, or all independent operations concurrently;
- expand any execution/result into a large inspection surface;
- render JSON, structured/tabular results, TOON, MCP content blocks, and raw payloads;
- preserve execution history and protocol evidence;
- correlate runtime traces with revision-aware source graphs;
- inspect relevant snippets, full symbols, and full files on demand;
- observe MCP calls made by agents/applications through supported capture points;
- copy one or more executions as deterministic Investigation Packets for local coding agents.

The privileged source/trace/local-process plane is intentionally separable from a future user-facing hosted execution plane.

## Architecture

```text
apps/
├── web/                  # React inspector UI
└── gateway/              # Node execution/API boundary

packages/
├── protocol/             # MCP era/version adapter
├── registry/             # server/capability discovery
├── storage/              # SQLite + artifact store + repositories + event log
├── runner/               # privileged local runner (JSON-RPC over UDS)
├── execution/            # multi-tool, MRTR, tasks
├── workspace/            # durable workspace model
├── renderers/            # result normalization/render selection
├── investigation/        # agent handoff packets
├── source-intelligence/  # source graph contracts/client
├── telemetry/            # trace contracts/correlation
└── ui/                   # reusable UI primitives

conformance/              # official MCP conformance integration
```

## Protocol policy

Architecture may be described as MCP `2026-07-28`-ready. Conformance is claimed only after the supported client behaviors pass the official MCP conformance suite.
