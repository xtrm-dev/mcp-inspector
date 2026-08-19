# MCP Inspector X

A visual, multi-tool Model Context Protocol inspector for capability discovery, concurrent execution, rich result rendering, source/runtime inspection, and deterministic agent handoff.

> Independent project. This repository is not the official Model Context Protocol Inspector maintained by the MCP project.

## Status

Early implementation. The protocol target is MCP `2026-07-28` modern era, with explicit legacy compatibility where required.

Canonical product requirements and V1 completion scope: [`docs/product/PRD.md`](docs/product/PRD.md).

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
