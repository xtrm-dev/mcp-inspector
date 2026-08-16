#!/usr/bin/env bash
# Semgrep against HEAD-vs-baseline diff. Used by pre-push so pre-existing
# debt doesn't block unrelated pushes. CI's full scan is source of truth.
#
# Baseline order: tracked upstream (@{u}) → origin/dev → origin/main → dev → main.
# Refuses to use the current branch as its own baseline.

set -euo pipefail

if ! command -v semgrep >/dev/null; then
    echo "semgrep not installed — skipping (CI covers it)"
    exit 0
fi

HEAD_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)
HEAD_SHA=$(git rev-parse HEAD)

upstream=$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)
BASE_REF=""
if [ -n "$upstream" ] && [ "$upstream" != "$HEAD_BRANCH" ]; then
    BASE_REF="$upstream"
else
    for cand in origin/dev origin/main dev main; do
        git rev-parse --verify "$cand" >/dev/null 2>&1 || continue
        [ "$cand" = "$HEAD_BRANCH" ] && continue
        BASE_REF="$cand"
        break
    done
fi

[ -n "$BASE_REF" ] && git fetch "${BASE_REF%%/*}" "${BASE_REF#*/}" --quiet 2>/dev/null || true

SEMGREP_BASELINE_ARGS=()
if [ -n "$BASE_REF" ]; then
    BASE=$(git merge-base HEAD "$BASE_REF" 2>/dev/null || true)
    [ -n "$BASE" ] && SEMGREP_BASELINE_ARGS=(--baseline-commit="$BASE")
fi
if [ ${#SEMGREP_BASELINE_ARGS[@]} -eq 0 ]; then
    BASE=$(git rev-list HEAD --max-count=50 | tail -1)
    if [ -n "$BASE" ] && [ "$BASE" != "$HEAD_SHA" ]; then
        SEMGREP_BASELINE_ARGS=(--baseline-commit="$BASE")
    else
        echo "[semgrep-diff] no usable baseline — running full scan"
    fi
fi

exec semgrep scan \
    --config=p/default \
    --config=p/security-audit \
    --config=p/secrets \
    --config=p/typescript \
    --config=p/javascript \
    --config=p/nodejs \
    --config=p/github-actions \
    "${SEMGREP_BASELINE_ARGS[@]}" \
    --error \
    --quiet \
    --skip-unknown-extensions
