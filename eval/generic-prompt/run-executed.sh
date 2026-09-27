#!/usr/bin/env bash
# Executed pilot on a prepared model-benchmark task; candidate workspaces are disposable.
set -euo pipefail

if [[ $# -ne 1 || ! -f "$1/control/prompt.txt" ]]; then
  echo "Usage: $0 <prepared-benchmark-dir>" >&2
  exit 2
fi

run_dir=$(realpath "$1")
repo=$(realpath "$(dirname "$0")/../..")
prompt=$(<"$run_dir/control/prompt.txt")
for arm in deepseek-simple deepseek-gpt luna-gpt luna-simple; do
  candidate="$run_dir/$arm"
  if [[ ! -d "$candidate" || -e "$candidate/dist" ]]; then
    echo "Expected untouched candidate workspace: $candidate" >&2
    exit 2
  fi
done

for arm in deepseek-simple deepseek-gpt luna-gpt luna-simple; do
  candidate="$run_dir/$arm"
  cp -a "$repo/dist" "$candidate/dist"
  # Prevent git commands in a history-free candidate from climbing into the
  # outer experiment worktree (and exposing unrelated work or history).
  mkdir "$candidate/.git"
  case "$arm" in
    deepseek-gpt) cp "$repo/source/prompts/gpt.md" "$candidate/dist/prompts/simple_v4.md" ;;
    luna-simple) cp "$repo/eval/generic-prompt/simple_v4.md" "$candidate/dist/prompts/gpt.md" ;;
  esac
done

sha256sum "$repo/source/prompts/gpt.md" "$repo/eval/generic-prompt/simple_v4.md" \
  "$run_dir"/*/dist/prompts/{gpt,simple_v4}.md > "$run_dir/control/prompt-hashes.txt"
git -C "$repo" rev-parse HEAD > "$run_dir/control/harness-commit.txt"

# Opposite arm order within the two models; 180 seconds maximum per candidate.
for arm in deepseek-simple luna-gpt deepseek-gpt luna-simple; do
  candidate="$run_dir/$arm"
  case "$arm" in
    deepseek-*) provider=DeepSeek; model=deepseek-flash ;;
    luna-*) provider=codex; model=gpt-6-luna ;;
  esac
  echo "Starting $arm ($provider/$model)"
  start=$(date +%s)
  status=0
  (
    cd "$candidate"
    timeout --signal=TERM --kill-after=10s 180s node "$candidate/dist/cli.js" \
      --json --auto-approve -p "$provider" -m "$model" -r medium "$prompt" \
      | node "$repo/eval/generic-prompt/filter-events.mjs"
  ) > "$run_dir/control/$arm.run.jsonl" 2> "$run_dir/control/$arm.run.stderr" || status=$?
  printf '%s\n' "$status" > "$run_dir/control/$arm.exit"
  echo "$(( $(date +%s) - start ))" > "$run_dir/control/$arm.seconds"
  echo "Finished $arm: exit $status, $(<"$run_dir/control/$arm.seconds")s"
done
