#!/usr/bin/env bash
# Prepare the demo fixture: a standalone local clone of term2 just before e828b819
# ("/clear discards the pending queue instead of leaving it armed").
# A plain clone, not a worktree: term2's subagent delegation rejects checkouts
# under .worktrees/ it did not create. Re-run before every take; it resets the clone.
set -euo pipefail
ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
WT="${DEMO_DIR:-/tmp/term2-demo}/term2"
if [ ! -d "$WT/.git" ]; then
  git clone -q --no-hardlinks "$ROOT" "$WT"
  git -C "$WT" checkout -q -B demo e828b819^
  git -C "$WT" remote remove origin  # keep the agent away from the real repo
  (cd "$WT" && pnpm install --frozen-lockfile)
fi
git -C "$WT" reset -q --hard e828b819^
git -C "$WT" clean -qfd -e node_modules
echo "Ready: $WT"
