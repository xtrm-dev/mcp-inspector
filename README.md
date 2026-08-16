# MCP Inspector X

A visual, multi-tool Model Context Protocol inspector for capability discovery, concurrent execution, rich result rendering, source/runtime inspection, and deterministic agent handoff.

> Independent project. This repository is not the official Model Context Protocol Inspector maintained by the MCP project.

## Status

Early implementation. The protocol target is MCP `2026-07-28` modern era, with explicit legacy compatibility where required.

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

- discover and inspect multiple MCP servers and tools;
- configure every tool independently;
- run one, selected, or all tools concurrently;
- expand any tool/result into a large inspection surface;
- render JSON, structured/tabular results, TOON, and raw payloads;
- preserve execution history and protocol evidence;
- correlate runtime traces with revision-aware source graphs;
- inspect relevant snippets, full symbols, and full files on demand;
- copy one or more executions as deterministic Investigation Packets for local coding agents.

The privileged source/trace plane is intentionally separable from a future user-facing hosted execution plane.

## Architecture

```text
apps/
├── web/                  # React inspector UI
└── gateway/              # Node execution/API boundary

packages/
├── protocol/             # MCP era/version adapter
├── registry/             # server/capability discovery
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
