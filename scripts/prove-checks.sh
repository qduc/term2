#!/usr/bin/env bash
# Shows each docs/architecture/layers.md rule check failing on a deliberately seeded violation, then restores the tree.
# Run on demand (about a minute); not part of CI. Usage: bash scripts/prove-checks.sh
set -u
cd "$(dirname "$0")/.."
fail=0
seed() { # name, file, content, command...
  local name=$1 file=$2 content=$3; shift 3
  local existed=0; [ -e "$file" ] && existed=1 && cp "$file" "$file.prove-bak"
  printf '%s' "$content" >> "$file"
  if "$@" >/tmp/prove-out 2>&1; then echo "NOT CAUGHT  $name"; fail=1; else echo "caught      $name: $(grep -m1 -E 'rule|imports|not reached|lines|grew|path' /tmp/prove-out | cut -c1-150)"; fi
  if [ $existed = 1 ]; then mv "$file.prove-bak" "$file"; else rm -f "$file"; fi
}
seed "wire event built outside protocol/" src/clients/tui/draft.ts $'\nexport const seededWire = { sessionId: "s", seq: 1, turnId: null, type: "text_delta", payload: {} };\n' node scripts/check-rules.mjs
seed "file named service" src/app/seeded-service.ts $'export const seeded = 1;\n' node scripts/check-rules.mjs
seed "new unused export" src/app/settings.ts $'\nexport function seededUnusedExport() { return 1; }\n' node scripts/check-rules.mjs
seed "leaf reducer imported outside foldFact" src/app/settings.ts $'\nimport { reduceDirectQueue } from "../session/queue-state.js";\nexport const seededFold = reduceDirectQueue;\n' node scripts/check-rules.mjs
seed "leaf-reducer module namespace-imported outside foldFact" src/app/settings.ts $'\nimport * as q from "../session/queue-state.js";\nexport const seededFold = q;\n' node scripts/check-rules.mjs
seed "leaf-reducer module dynamically imported outside foldFact" src/app/settings.ts $'\nexport const seededFold = import("../session/queue-state.js");\n' node scripts/check-rules.mjs
seed "app/ reads a session log" src/app/settings.ts $'\nexport const seededReader = readFactLines;\n' node scripts/check-layers.mjs
seed "engine imports app (layer direction)" src/engine/turn.ts $'\nimport "../app/settings.js";\n' node scripts/check-layers.mjs
seed "file never reached from app/cli.ts" src/app/seeded-dead.ts $'export const dead = 1;\n' node scripts/check-reachability.mjs
seed "file over 500 lines" src/app/seeded-big.ts "$(for i in $(seq 520); do echo "export const v$i = $i;"; done)" node scripts/check-complexity.mjs
seed "allowlist grew" scripts/layer-allowlist.json $'\n"src/engine/turn.ts -> src/app/settings.ts (engine -> app)"\n' node scripts/check-baselines.mjs
seed "unallowlisted root file" seeded-root-file.md $'seeded\n' node scripts/check-root.mjs
exit $fail
