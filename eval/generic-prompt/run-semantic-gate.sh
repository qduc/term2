#!/usr/bin/env bash
# Score the stated credential contract without changing the original hidden gate.
set -euo pipefail

if [[ $# -ne 1 || ! -d "$1/candidates/r-settings-secret-display" ]]; then
  echo "Usage: $0 <prepared-grid-directory>" >&2
  exit 2
fi
root=$(realpath "$1")
repo=$(realpath "$(dirname "$0")/../..")
evaluator=/home/qduc/.agents/skills/model-benchmark/scripts/run-evaluator.sh
for rep in 1 2; do
  alternative="$root/semantic/r-settings-secret-display/rep-$rep"
  mkdir -p "$alternative/control"
  cp "$root/runs/r-settings-secret-display/rep-$rep/control/task.json" \
    "$root/runs/r-settings-secret-display/rep-$rep/control/meta.json" "$alternative/control/"
  cp "$repo/eval/generic-prompt/credential-semantic.test-template.txt" "$alternative/control/evaluator.test.ts"
  for arm in deepseek-simple deepseek-gpt luna-gpt luna-simple; do
    ln -s "$root/candidates/r-settings-secret-display/rep-$rep/$arm" "$alternative/$arm"
  done
  "$evaluator" --benchmark-dir "$alternative" | grep -E 'Evaluating Candidate|RESULT:|Evaluation complete'
done
