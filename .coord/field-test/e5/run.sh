#!/bin/bash
# usage: run.sh <build-dir> <label> <task:a|b|d> <mkey> <model-id>
build="$1"; label="$2"; t="$3"; k="$4"; model="$5"
root=/home/qduc/term2
out=$root/.coord/field-test/e5/out
mkdir -p "$out"
$root/.coord/field-test/e5/reset.sh "$t" "$k" >/dev/null || exit 1
cd "$root/.worktrees/e5-$t-$k" || exit 1
start=$(date +%s)
timeout 2400 node "$build/dist/cli.js" --auto-approve -q -p opencode -m "$model" \
  "$(cat $root/.coord/field-test/e5/task$t.txt)" \
  < /dev/null > "$out/$label-$t-$k.out" 2> "$out/$label-$t-$k.err"
code=$?
# Capture against main, not the worktree HEAD: models often commit their
# work, which leaves a plain `git diff` empty.
git -C "$root/.worktrees/e5-$t-$k" diff main -- source > "$out/$label-$t-$k.diff" 2>/dev/null
echo -e "$label\t$t\t$k\t$code\t$(( $(date +%s) - start ))s" >> "$out/summary.tsv"
# Record which traffic session this cell produced, so token accounting does not
# have to infer pairs from ordering.
# Pick the OLDEST session dir created at or after this cell started, not the
# newest overall: a concurrent run (an E4 re-run did exactly this) creates a
# newer dir mid-cell and silently steals the mapping.
day=$(date -u +%Y-%m-%d)
newest=$(ls -d ~/.local/state/term2-nodejs/logs/provider-traffic/$day/*/ 2>/dev/null \
  | awk -v s="$(date -u -d @$start +%H-%M-%S)" -F/ '{n=$(NF-1); if (n >= s) print n}' \
  | sort | head -1)
# Fall back to the newest dir if the window match found nothing.
[ -z "$newest" ] && newest=$(ls -d ~/.local/state/term2-nodejs/logs/provider-traffic/$day/*/ 2>/dev/null | sort | tail -1)
echo -e "$label\t$t\t$k\t$(basename "$newest")" >> "$out/sessions.tsv"
