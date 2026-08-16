#!/usr/bin/env bash
# Local security AUDIT — informational, never fails.
# Surfaces all findings incl. pre-existing debt. Pre-push (diff-only) blocks; CI is SoT.
#
# Usage: ./scripts/security-scan.sh [--quick]   # --quick: gitleaks only

set -uo pipefail
cd "$(git rev-parse --show-toplevel)"

QUICK=0
[[ "${1:-}" == "--quick" ]] && QUICK=1

FINDINGS=0

echo "── gitleaks (working tree, no-git) ──"
if command -v gitleaks >/dev/null; then
    gitleaks detect --source . --config .gitleaks.toml --no-banner --no-git \
      || FINDINGS=$((FINDINGS + 1))
else
    echo "  gitleaks not installed"
fi

if [ "$QUICK" = "0" ]; then
    echo
    echo "── semgrep (full repo) ──"
    if command -v semgrep >/dev/null; then
        semgrep --config=p/default --config=p/security-audit --config=p/secrets \
                --config=p/typescript --config=p/javascript --config=p/nodejs \
                --config=p/github-actions \
                --error --skip-unknown-extensions --quiet 2>&1 \
          || FINDINGS=$((FINDINGS + 1))
    else
        echo "  semgrep not installed"
    fi

    echo
    echo "── osv-scanner ──"
    if command -v osv-scanner >/dev/null; then
        osv-scanner --recursive ./ || FINDINGS=$((FINDINGS + 1))
    else
        echo "  osv-scanner not installed"
    fi
fi

echo
if [ "$FINDINGS" -eq 0 ]; then
    echo "✅ Clean — no findings."
else
    echo "⚠️  $FINDINGS scanner(s) reported findings — triage above."
    echo "   Pre-push blocks only NEW findings vs origin/dev; pre-existing debt is tracked separately."
fi
exit 0
