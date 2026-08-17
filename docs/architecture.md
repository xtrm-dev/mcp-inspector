# MCP Inspector X architecture

## Product boundary

MCP Inspector X is an independent, general-purpose MCP inspection product. It is not coupled to Mercury services or to any one hosted platform.

```text
Web UI
  ↓
Workspace model
  ↓
Execution orchestration
  ↓
Protocol adapter
  ↓
Official MCP SDK
```

Source/runtime intelligence is lateral rather than part of the critical execution path:

```text
ExecutionRecord ───────────────┐
                              ├─ Combined inspector
Revision-aware SourceGraph ───┤
OpenTelemetry Trace ──────────┘
```

## Trust planes

```text
Safe hosted plane
  tool discovery
  tool execution
  user-owned history
  rich results

Privileged intelligence plane
  stdio process runner
  private source graph
  full source files
  internal traces
  deployment metadata
  full Investigation Packet
```

The backend enforces entitlements. Hiding a UI control is not an authorization mechanism.

## Protocol

Target: MCP `2026-07-28` modern era.

Legacy compatibility is explicit. Protocol era, version, capabilities, extension negotiation, MRTR rounds, task transitions, headers, `_meta`, and trace context are persisted as inspectable evidence.

`packages/protocol` is the only product-facing seam around the official SDK. Product packages must not depend directly on upstream Inspector internals.

## Upstream Inspector policy

The official `modelcontextprotocol/inspector` V2 is a reference and selective implementation source. Its internal `@inspector/core` is not a stable published product dependency. Any source-derived implementation must pin the upstream commit and preserve required attribution/license notices.

## Architectural decisions

- [ADR-0001 — Agent-Run MCP Trace Capture, Correlation, and Replay](adr/0001-agent-run-mcp-trace-capture-and-replay.md)
