# MCP Inspector X — Design References

This directory holds the canonical **visual and interaction** reference material
for the product. It is design authority, not protocol or product-scope
authority.

## Authority hierarchy

Canonical product requirements:
`docs/product/PRD.md`

Canonical architecture:
`docs/adr/0001-agent-run-mcp-trace-capture-and-replay.md`
`docs/adr/0002-modern-mcp-trace-context-and-local-stdio-capture.md`
`docs/adr/0003-complete-v1-architecture-and-completion-contract.md`

Canonical historical visual reference:
`docs/design/mockups/2026-08-16-mercury-inspector-v2-reference.html`

## Rules of the mockup

- The mockup is an interaction, information-architecture, and density
  reference. It is not a product-scope authority. Where the PRD and the
  mockup disagree, the PRD wins.
- The mockup predates the standalone rename from **Mercury Inspector** to
  **MCP Inspector X**. Its "Mercury" branding, sidebar labels, sample
  server names (`market-data`, `treasury`, `economic-data`, `darth-feedor`),
  sample tools, and sample data are **historical fixtures** captured before
  generalization. Implementation must adapt those to generic MCP Inspector X
  terminology and to whatever servers the operator actually has connected.
- Implementation must not literally reproduce Mercury labels or sample
  data. It must reproduce the **structural model**: workspace-first shell,
  Graph / Grid / List projections over the same nodes, collapsed / expanded
  / focus card states, shared local inspection tabs, right-hand detail
  pane with Source + Trace + History + Agent Handoff.
- The mockup must not be silently replaced by a wholly different generic
  CRUD dashboard. Any replacement requires an explicit recorded product
  decision (PRD amendment or ADR).
- The historical HTML is preserved verbatim. Renames or edits to the
  historical file are prohibited. Newer references belong beside it, dated.

## What the mockup fixes

At the time the mockup was authored the intended visual language was:

- Linear-like interaction density.
- Datadog-like operational hierarchy.
- Restrained chrome, a few professional colors, dark palette.
- Large usable canvas, compact navigation, high information density.
- Clear status, resizable panes, large result surfaces, full-screen
  result / code, keyboard-friendly interactions.

What it explicitly rejects:

- Large empty cards, oversized typography, excessive gradients.
- Rainbow status colors, dashboard-KPI decoration, marketing-page spacing.
- Generic Material-style admin panels.

## Contents

- `mockups/2026-08-16-mercury-inspector-v2-reference.html`
  Canonical V2 interactive reference. Source of truth for shell,
  projections, card states, inspection tabs, right-pane composition,
  Agent Handoff modal, and code / trace surfaces.

- `mockups/archive/`
  Older references kept for provenance. Not authoritative.

## Interpretation for the current campaign

The current `/api/v1` SPA replaced the intended workspace-first shell with
sibling CRUD pages. This regressed the product against the PRD. The
`R-UX` reconstruction epic restores the workspace-first shell over the
existing backend (no fork of domain state). See the R-UX slices
(`UX-0` … `UX-8`) tracked on GitHub issue #23 and its child issues.
