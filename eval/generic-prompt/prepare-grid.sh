#!/usr/bin/env bash
# Prepare history-isolated, paired coding-task candidates from fixed commits.
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <new-output-directory>" >&2
  exit 2
fi
repo=$(realpath "$(dirname "$0")/../..")
root=$(realpath -m "$1")
runtime=${GRID_DIST_DIR:-$repo/dist}
if [[ ${GRID_MODEL:-} == sol ]]; then
  arms=(sol-simple sol-gpt)
else
  arms=(deepseek-simple deepseek-gpt luna-gpt luna-simple)
fi
skill=/home/qduc/.agents/skills/model-benchmark
if [[ -e "$root" || ! -d "$runtime/prompts" ]]; then
  echo "Expected a new output directory and a built runtime" >&2
  exit 2
fi
mkdir -p "$root/runs" "$root/candidates"
for task in c11-d5-batch-denial-tristate r-settings-secret-display r-retry-abort-backoff; do
  if [[ -n ${GRID_TASK:-} && "$task" != "$GRID_TASK" ]]; then continue; fi
  task_dir="$skill/tasks/$task"
  if [[ "$task" == c11-d5-batch-denial-tristate ]]; then
    base=358fd042e807c37004f1755d2f43c6d53e03df9c
  else
    base=$(node -p "require('$task_dir/task.json').base_commit")
  fi
  git -C "$repo" rev-parse --verify "$base^{commit}" >/dev/null
  for rep in 1 2; do
    run="$root/runs/$task/rep-$rep"
    mkdir -p "$run/control"
    cp "$task_dir/task.json" "$task_dir/prompt.txt" "$task_dir/evaluator.test.ts" "$run/control/"
    printf '%s\n' "$(git -C "$repo" rev-parse "$base")" > "$run/control/base_commit"
    node - "$run/control/meta.json" "$task" "$(IFS=,; echo "${arms[*]}")" <<'JS'
const fs = require('node:fs');
fs.writeFileSync(process.argv[2], JSON.stringify({task_id: process.argv[3],
  candidates: process.argv[4].split(',')}, null, 2));
JS
    for arm in "${arms[@]}"; do
      candidate="$root/candidates/$task/rep-$rep/$arm"
      mkdir -p "$candidate"
      git -C "$repo" archive "$base" | tar -x -C "$candidate"
      for stripped in $(node -p "(require('$task_dir/task.json').strip_files || []).join(' ')"); do
        # Strip only manifest-listed answer-bearing tests from disposable copies.
        if [[ -f "$candidate/$stripped" ]]; then
          mv "$candidate/$stripped" "$run/control/stripped-$arm-$(basename "$stripped")"
        fi
      done
      cp "$run/control/prompt.txt" "$candidate/BENCH-TASK.md"
      cp -a "$runtime" "$candidate/dist"
      case "$arm" in
        deepseek-gpt) cp "$repo/source/prompts/gpt.md" "$candidate/dist/prompts/simple_v4.md" ;;
        luna-simple|sol-simple) cp "$repo/eval/generic-prompt/simple_v4.md" "$candidate/dist/prompts/gpt.md" ;;
      esac
      # Shallow dependency links keep candidate installs from replacing the
      # shared node_modules directory while reusing the local pnpm store.
      mkdir "$candidate/node_modules"
      for entry in "$repo"/node_modules/*; do
        [[ -e "$entry" ]] || continue
        name=$(basename "$entry")
        if [[ "$name" == @* ]]; then
          mkdir "$candidate/node_modules/$name"
          for member in "$entry"/*; do
            [[ -e "$member" ]] || continue
            ln -s "$member" "$candidate/node_modules/$name/$(basename "$member")"
          done
        else
          ln -s "$entry" "$candidate/node_modules/$name"
        fi
      done
      ln -s "$repo/node_modules/.bin" "$candidate/node_modules/.bin"
      git -C "$candidate" init -q
      git -C "$candidate" add -A
      git -C "$candidate" -c user.name=Benchmark -c user.email=benchmark@localhost commit -qm 'History-free task baseline'
      ln -s "$candidate" "$run/$arm"
    done
    sha256sum "$run"/*/dist/prompts/{gpt,simple_v4}.md > "$run/control/prompt-hashes.txt"
    echo "Prepared $task rep-$rep from $(<"$run/control/base_commit")"
  done
done
