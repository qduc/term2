#!/usr/bin/env bash
# Execute the prepared grid; each arm is bounded and its JSON stream filtered.
set -euo pipefail

if [[ $# -ne 1 || ! -d "$1/runs" ]]; then
  echo "Usage: $0 <prepared-grid-directory>" >&2
  exit 2
fi
root=$(realpath "$1")
repo=$(realpath "$(dirname "$0")/../..")
for task in c11-d5-batch-denial-tristate r-settings-secret-display r-retry-abort-backoff; do
  if [[ -n ${GRID_TASK:-} && "$task" != "$GRID_TASK" ]]; then continue; fi
  case "$task" in
    c11-d5-*) limit=180 ;;
    r-settings-*) limit=240 ;;
    r-retry-*) limit=360 ;;
  esac
  if [[ -n ${GRID_CAP_SECONDS:-} ]]; then
    if [[ ! $GRID_CAP_SECONDS =~ ^[1-9][0-9]*$ ]]; then
      echo "GRID_CAP_SECONDS must be a positive integer" >&2
      exit 2
    fi
    limit=$GRID_CAP_SECONDS
  fi
  for rep in 1 2; do
    run="$root/runs/$task/rep-$rep"
    prompt=$(<"$run/control/prompt.txt")
    if [[ ${GRID_MODEL:-} == sol && "$rep" == 1 ]]; then
      order=(sol-simple sol-gpt)
    elif [[ ${GRID_MODEL:-} == sol ]]; then
      order=(sol-gpt sol-simple)
    elif [[ "$rep" == 1 ]]; then
      order=(deepseek-gpt luna-simple deepseek-simple luna-gpt)
    else
      order=(luna-gpt deepseek-simple luna-simple deepseek-gpt)
    fi
    for arm in "${order[@]}"; do
      candidate=$(realpath "$run/$arm")
      if [[ -e "$run/control/$arm.exit" ]]; then
        echo "Refusing to repeat an already attempted arm: $task rep-$rep $arm" >&2
        exit 2
      fi
      case "$arm" in
        deepseek-*) provider=DeepSeek; model=deepseek-flash ;;
        luna-*) provider=codex; model=gpt-6-luna ;;
        sol-*) provider=codex; model=gpt-6-sol ;;
      esac
      echo "Starting $task rep-$rep $arm (cap ${limit}s)"
      start=$(date +%s)
      status=0
      (
        cd "$candidate"
        timeout --signal=TERM --kill-after=10s "${limit}s" node "$candidate/dist/cli.js" \
          --json --auto-approve -p "$provider" -m "$model" -r medium "$prompt" \
          | node "$repo/eval/generic-prompt/filter-events.mjs"
      ) > "$run/control/$arm.run.jsonl" 2> "$run/control/$arm.run.stderr" || status=$?
      printf '%s\n' "$status" > "$run/control/$arm.exit"
      echo "$(( $(date +%s) - start ))" > "$run/control/$arm.seconds"
      echo "Finished $task rep-$rep $arm: exit $status, $(<"$run/control/$arm.seconds")s"
    done
  done
done
