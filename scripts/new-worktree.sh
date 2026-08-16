#!/usr/bin/env bash
# Create a worktree branched from origin/dev. Never from main.
#
# Usage: ./scripts/new-worktree.sh <branch-slug> [worktree-dir]
#   branch-slug   e.g. feature/foo-bar (or plain 'foo-bar' — gets 'feature/' prefix)
#   worktree-dir  optional; default: ../<repo>-<sanitized-slug>

set -euo pipefail

if [ $# -lt 1 ]; then
    echo "Usage: $0 <branch-slug> [worktree-dir]" >&2
    exit 1
fi

SLUG="$1"
case "$SLUG" in
    feature/*|feat/*|fix/*|chore/*|hotfix/*|release/*) BRANCH="$SLUG" ;;
    *) BRANCH="feature/$SLUG" ;;
esac

REPO_ROOT=$(git rev-parse --show-toplevel)
REPO_NAME=$(basename "$REPO_ROOT")
SAFE_SLUG=$(echo "$BRANCH" | tr '/' '-')
WT_DIR="${2:-$(dirname "$REPO_ROOT")/${REPO_NAME}-${SAFE_SLUG}}"

echo "→ Fetching origin/dev ..."
git fetch origin dev

echo "→ Creating worktree: $WT_DIR (branch $BRANCH from origin/dev)"
git worktree add "$WT_DIR" -b "$BRANCH" origin/dev

echo
echo "✅ Worktree ready:"
echo "   cd $WT_DIR"
