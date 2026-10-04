#!/usr/bin/env bash
# Record a full, unattended term2 run with asciinema inside a detached tmux pane,
# then retime it and render docs/demo/out/<take>.gif.
# Needs: tmux, asciinema, agg (brew install tmux asciinema agg).
# Usage: docs/demo/record.sh [take-name]
set -euo pipefail
DEMO="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(git -C "$DEMO" rev-parse --show-toplevel)"
WT="${DEMO_DIR:-/tmp/term2-demo}/term2"
TAKE="${1:-take}"
OUT="$DEMO/out"; mkdir -p "$OUT"
CAST="$OUT/$TAKE.raw.cast"
PROMPT="Bug: if I queue a message while a turn is running and then run /clear, the queued message still gets sent into the fresh session. Find the root cause, fix it, add a regression test, and run the affected tests."
S=term2demo

"$DEMO/setup.sh"
tmux kill-session -t $S 2>/dev/null || true
tmux new-session -d -s $S -x 120 -y 34 -c "$WT" \
  "asciinema rec --overwrite -q --cols 120 --rows 34 -c term2 '$CAST'"

pane() { tmux capture-pane -p -t $S; }
wait_for() { for _ in $(seq 1 "$2"); do pane | grep -q -- "$1" && return 0; sleep 1; done; echo "timeout waiting for: $1" >&2; pane >&2; return 1; }

wait_for "STANDARD" 30
sleep 2
tmux send-keys -t $S -l "$PROMPT"; sleep 1; tmux send-keys -t $S Enter

# Done = no busy indicator for 20 consecutive seconds (after it first appeared).
sleep 15; idle=0; start=$(date +%s)
while (( idle < 20 )); do
  if pane | grep -Eq 'Processing|Calling tool|Thinking|Running|[1-9][0-9]* active|· [0-9]+s'; then idle=0; else idle=$((idle+1)); fi
  (( $(date +%s) - start > 1500 )) && { echo "run exceeded 25 min" >&2; break; }
  sleep 1
done
pane > "$OUT/$TAKE.final.txt"
sleep 3
tmux send-keys -t $S C-c; sleep 1; tmux send-keys -t $S C-c; sleep 3
tmux kill-session -t $S 2>/dev/null || true
python3 "$DEMO/retime.py" "$CAST" "$OUT/$TAKE.cast" 1.2
agg --idle-time-limit 1.2 --speed 1.3 --font-size 16 --theme dracula --last-frame-duration 12 \
  "$OUT/$TAKE.cast" "$OUT/$TAKE.gif" >/dev/null
echo "rendered: $OUT/$TAKE.gif (copy to docs/demo/demo.gif once it looks right)"
