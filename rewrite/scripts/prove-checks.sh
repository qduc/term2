#!/usr/bin/env bash
# Shows each rewrite/README.md rule check failing on a deliberately seeded violation, then restores the tree.
# Run on demand (about a minute); not part of CI. Usage: bash rewrite/scripts/prove-checks.sh
set -u
cd "$(dirname "$0")/../.."
fail=0
seed() { # name, file, content, command...
  local name=$1 file=$2 content=$3; shift 3
  local existed=0; [ -e "$file" ] && existed=1 && cp "$file" "$file.prove-bak"
  printf '%s' "$content" >> "$file"
  if "$@" >/tmp/prove-out 2>&1; then echo "NOT CAUGHT  $name"; fail=1; else echo "caught      $name: $(grep -m1 -E 'rule|imports|not reached|lines|grew|path' /tmp/prove-out | cut -c1-150)"; fi
  if [ $existed = 1 ]; then mv "$file.prove-bak" "$file"; else rm -f "$file"; fi
}
seed "wire event built outside protocol/" rewrite/src/clients/tui/draft.ts $'\nexport const seededWire = { sessionId: "s", seq: 1, turnId: null, type: "text_delta", payload: {} };\n' node rewrite/scripts/check-rules.mjs
seed "file named service" rewrite/src/app/seeded-service.ts $'export const seeded = 1;\n' node rewrite/scripts/check-rules.mjs
seed "new unused export" rewrite/src/app/settings.ts $'\nexport function seededUnusedExport() { return 1; }\n' node rewrite/scripts/check-rules.mjs
seed "leaf reducer imported outside foldFact" rewrite/src/app/settings.ts $'\nimport { reduceDirectQueue } from "../session/direct-queue-state.js";\nexport const seededFold = reduceDirectQueue;\n' node rewrite/scripts/check-rules.mjs
seed "leaf-reducer module namespace-imported outside foldFact" rewrite/src/app/settings.ts $'\nimport * as q from "../session/direct-queue-state.js";\nexport const seededFold = q;\n' node rewrite/scripts/check-rules.mjs
seed "leaf-reducer module dynamically imported outside foldFact" rewrite/src/app/settings.ts $'\nexport const seededFold = import("../session/direct-queue-state.js");\n' node rewrite/scripts/check-rules.mjs
seed "app/ reads a session log" rewrite/src/app/settings.ts $'\nexport const seededReader = readFactLines;\n' node rewrite/scripts/check-layers.mjs
seed "engine imports app (layer direction)" rewrite/src/engine/turn.ts $'\nimport "../app/settings.js";\n' node rewrite/scripts/check-layers.mjs
seed "file never reached from app/cli.ts" rewrite/src/app/seeded-dead.ts $'export const dead = 1;\n' node rewrite/scripts/check-reachability.mjs
seed "file over 500 lines" rewrite/src/app/seeded-big.ts "$(for i in $(seq 520); do echo "export const v$i = $i;"; done)" node rewrite/scripts/check-complexity.mjs
exit $fail
