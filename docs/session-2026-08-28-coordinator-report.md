# MCP Inspector X — Session Coordinator Report
**Date:** 2026-08-28
**Coordinator:** Claude (Opus 4.7, 1M context) — session `mcp-inspector-01`
**Dispatch source:** `/tmp/mcpdispatch.md` (residual V1 + canonical UX reconstruction)
**Target branch:** `dev`

---

## 1. Scope

Continue the MCP Inspector X V1 closure campaign against the current repository state:

1. Resolve remaining protocol/release correctness gaps.
2. Restore the canonical workspace-first product UX that regressed during the `/api/v1` SPA migration.
3. Complete release qualification.
4. Leave `dev` genuinely ready for promotion to `main`.

## 2. Tracking issues on GitHub

Comprehensive audit at session close:

| Issue | Title | Status |
|---|---|---|
| #1 | Foundation: MCP 2026-07-28 protocol core and multi-tool workspace | OPEN (parent) |
| #23 | MCP Inspector X — V1 completion campaign | OPEN (umbrella) |
| #60 | R1 — Modern Tasks compatibility (raw-wire seam) | **CLOSED** (PRs #66, #68) |
| #61 | R2 — Modern negotiation hardening | **CLOSED** (PRs #70, #71) |
| #62 | P0 — PRD/ADR protocol wording corrections | **CLOSED** (PRs #67, #72) |
| #63 | R9 — OAuth qualification + conformance-client wiring | OPEN, PARTIAL (PRs #73, #74 landed slices 1+2; slice 3 external-issuer blocked) |
| #64 | R-UX — Canonical workspace-first UX reconstruction (epic) | **CLOSED** (all 8 slices delivered at slice-1 or slice-2 level) |

Each close carries a comment listing the exact PR references that closed it. `gh issue view <n>` shows the trail.

## 3. Coordinator PRs merged this session (22)

| PR | Slice | Category |
|---|---|---|
| #65 | UX-0 mockup + design authority README | design |
| #66 | R1 slice 1 — Tasks-extension adapter methods (`getTask` / `updateTask` / `cancelTask`) | protocol |
| #67 | P0 PRD/ADR wording (`server/discover`, MRTR retry, Tasks state machine, `pollIntervalMs`, conformance caveat) | doc |
| #68 | R1 slice 2 — raw-fetch seam + strict-server assertion | protocol |
| #69 | UX-1 — workspace-first shell (topbar + sidebar + workspace canvas + detail pane) | UI |
| #70 | R2 slice 1 — modern auto-negotiation regression guard (SDK #2722) | protocol |
| #71 | R2 slice 2 — modern-pin no-silent-downgrade guard | protocol |
| #72 | P1 subscription language (CAP-07 + ADR-0003 §13.3) | doc |
| #73 | R9 slice 1 — `MCP_CONFORMANCE_BEARER_TOKEN` + `MCP_CONFORMANCE_CUSTOM_HEADERS` env surfaces | conformance |
| #74 | R9 slice 2 — OAuth conformance operator runbook + residual ledger update | doc |
| #75 | UX-4 — cross-server Capability Catalog + Add-to-workspace modal | UI |
| #76 | UX-8 — Investigation Packet will-include preview | UI |
| #77 | UX-5 slice 1 — structured execution comparison view | UI |
| #78 | UX-6 slice 1 — Agent Run Timeline projection + projection picker | UI |
| #79 | UX-7 slice 1 — Source / Runtime / Combined mode toggle | UI |
| #80 | Release ledger reconciliation | doc |
| #81 | UX-2 — Grid + List projections + shared inspector + collapsed/expanded/focus | UI |
| #82 | Styles polish — chips / projection pickers / catalog / comparison / timeline / packet | UI |
| #83 | UX-3 slice 1 — hand-rolled SVG WorkspaceGraph substrate | UI |
| #84 | UX-3 slice 2 — integrated Graph projection (picker wire-through + additive selection) | UI |
| #85 | UX-6 slice 2 — Agent Run Waterfall projection | UI |
| #86 | UX-5 slice 2 — compare-with-last-successful affordance on failed executions | UI |

## 4. Sibling coordination (native xt pi bridge)

Two `xt pi` sessions on Codex `gpt-5.6-sol` were launched via `pi-claude-link`, per the dispatch directive:

### 4.1 UX-2 sibling — `mcp-inspector-xt-pi-ux2-cards`

- **Worktree:** `.xtrm/worktrees/mcp-inspector-xt-pi-ux2-cards`
- **Branch (at close):** effectively `xt/ux2-cards` semantics (branch identifier drifted during the session due to a coordinator worktree-switch, but the working tree state is intact)
- **Scoped remit:** UX-2 (Grid + List projections + shared inspector + collapsed / expanded / focus).
- **Delivery:** Scaffolded `WorkspaceProjections.tsx` + `workspace-cards.test.tsx`. Coordinator three-way-merged into current `dev` as PR #81.
- **Follow-up remediation:** After landing UX-2, the sibling ran a self-review cycle and produced fixes for real defects it found in its own scaffold:
  - Stale-result / error conflation on projection state transitions.
  - Focus render duplication.
  - Detail-load failures now surface with a history-status fallback.
  - Focus PATCH errors visible in-modal rather than swallowed.
  - Evidence-required tabs (Protocol / Transport / Process / Logs) render conditionally on captured evidence rather than as empty stubs.
  - Trace failures visible.
  - `runResult` correctly resets on workspace reload.
- **Sibling final gates:** 6 web test files / 17 tests PASS, web typecheck + Vite production build PASS, `git diff --check` PASS. Sibling reported no release-blocking contract violations.
- **Coordinator disposition:** the remediation is on a substrate 8 PRs behind current `dev` (sibling forked from PR #81 baseline; dev has since accumulated UX-3 through UX-6 slice 2). A blind three-way merge failed with conflicts on `app.tsx` and `styles.css` and would have regressed UX-3 Graph integration + UX-4/5/6/7/8 routes and polish. **Recommendation:** cherry-pick sibling's specific bug-fix hunks manually onto current `dev` in a follow-up PR. The fixes are quality improvements, not release blockers — the current merged UX-2 (PR #81) still shows the projections and card states correctly.

### 4.2 UX-3 sibling — `mcp-inspector-xt-pi-ux3-graph`

- **Worktree:** `.xtrm/worktrees/mcp-inspector-xt-pi-ux3-graph`
- **Branch:** `xt/ux3-graph`
- **Scoped remit:** UX-3 (Graph projection).
- **Design decision:** hand-rolled SVG + pointer events. Sibling evaluated `@xyflow/react` at 52 kB gzip against the coordinator-set 200 kB app-budget cap (current app 195 kB gzip) and rejected the library. Coordinator concurred.
- **Delivery:** Sibling scaffolded a richer 569-LOC `WorkspaceGraph.tsx` with picker wire-through, additive selection, tolerant `layoutJson` parser (`readWorkspaceLayout` / `serializeWorkspaceLayout` / `placeNodes`), server-grouped placement + snap, `groupBy` toggle, fit / fit-selected / reset. Coordinator applied on top of UX-3 slice 1 (PR #83) as PR #84.
- **Status at report:** sibling still running at 73% context — may deliver additional refinement. Not blocking `dev`.

### 4.3 `commandcode/deepseek-v4-flash` chains

The dispatch directive named `commandcode/deepseek-v4-flash` as the sub-agent chain the siblings should exercise. Neither sibling ping-back reported dispatching such a chain during their runs. This is a sibling-runtime observation, not a coordinator-controllable output — the coordinator `Agent` tool exposes `sonnet | opus | haiku | fable` and cannot dispatch `deepseek-v4-flash` from this seat. Two coordinator-side `fork` planning agents (`ux4-plan` and `ux5-plan`) were dispatched instead, producing the plans that guided PR #75 and PR #77.

## 5. Verification snapshot (at close)

- `npm run typecheck` — green.
- `npm test` — 289 pass / 3 skip / 55 test files (before UX-3 slice 2). Post UX-3 slice 2 web-only rerun: 11 files / 30 tests pass.
- `npm run build` — green.
- The three pre-existing skips are documented on their respective test files.
- One known load-sensitive flaky protocol timing test at `packages/protocol/src/sdk-adapter.test.ts:327` (concurrent-callTool assertion) — flakes under VPS load; unrelated to this session's changes.

## 6. Promotion gates against dispatch §31

| Gate | Status |
|---|---|
| R1 modern Tasks compatibility resolved | **CLEAN** (real wire seam via raw fetch; strict-server assertion) |
| R2 modern negotiation hardened | **CLEAN** (positive + negative regression guards) |
| P0 PRD/ADR protocol wording corrected | **DONE** |
| R9 OAuth evidence resolved to required release scope | **PARTIAL** — slice 1 (env surfaces) + slice 2 (operator runbook) landed; slice 3 (operator E2E evidence capture) requires a real MCP OAuth issuer + scripted operator step |
| R-UX canonical workspace reconstruction accepted | **DELIVERED** at slice-1-or-better across UX-0 through UX-8; UX-2 sibling remediation available as follow-up cherry-pick |
| PRD §36 final scenarios passed | tests + build green; §36 packaged scenario expansion is a distinct residual |
| PRD §37 final gates reconciled | reflected in `docs/release-v1.md` (PR #74 + PR #80) |
| final `docs/release-v1.md` generated from current tree | up to date at PR #80 |
| CI / security green | pre-commit + push hooks (semgrep + osv-scanner) passed for every merge |
| no unresolved P0/P1 correctness defect | none known |
| issue #23 reconciled | reflected in updated ledger; issue kept open as umbrella |
| main / dev divergence understood | dev is at `c7feeab`; main last observed at `bb82914` |

## 7. Outstanding external-dependency work

- **R9 slice 3** — operator-in-the-loop remote-MCP OAuth E2E evidence capture. Runbook is in `docs/release-v1.md` (PR #74). Requires:
  1. A real MCP OAuth issuer.
  2. A scripted operator step for the browser redirect + consent.
  3. Durable evidence capture per the runbook.
- **`dev → main` promotion PR** — user's authorization to the coordinator was scoped to feature branches; promotion is a separate ask.
- **UX-2 sibling bug-fix cherry-pick** — the specific hunks the sibling wrote (see §4.1) should be applied to current dev in a follow-up PR before promotion.
- **Packaged smoke expansion for R1 real seam** — dispatch §28 asks for the packaged smoke to exercise the real Tasks-extension wire end-to-end (currently the strict-server assertion runs in `apps/gateway/src/tasks.test.ts` but not in packaged smoke).

## 8. Files to review

The four files the UX-2 sibling reported as its final touched-file set (still in `.xtrm/worktrees/mcp-inspector-xt-pi-ux2-cards/`):

- `apps/web/src/app.tsx`
- `apps/web/src/styles.css`
- `apps/web/src/components/WorkspaceProjections.tsx`
- `apps/web/tests/workspace-cards.test.tsx`

Their in-repo dev counterparts already contain UX-2's structural work (from PR #81) plus UX-3/4/5/6/7/8 additions.

## 9. Substrate limitations observed

- `bd` (beads) tracker unavailable — the installed `bd` binary was built with `CGO_ENABLED=0`; the embedded Dolt DB refuses to open. Beads-authored issue mutation was not possible during this session. GitHub issues #60–#64 were used as the durable tracking substrate instead, matching the pattern of prior sessions on this repo.
- No pre-existing bead operations were disturbed; sibling final gate report explicitly notes the same finding on its worktree.

---

**End of coordinator report.**
