#!/usr/bin/env bash
# Shows each docs/architecture/layers.md rule check failing on a deliberately seeded violation, then restores the tree.
# A seed counts as caught only when the expected rule reports it: a crash or another rule's failure is NOT CAUGHT.
# Also proves the judgement route: a deviation that carries a reason passes and is listed for the reviewer.
# Run on demand (about a minute); not part of CI. Usage: bash scripts/prove-checks.sh
set -u
cd "$(dirname "$0")/.."
export MERGE_BASE="${MERGE_BASE:-HEAD}"
fail=0
out=$(mktemp)
backups=()
backup() { for f in "$@"; do if [ -e "$f" ]; then cp "$f" "$f.prove-bak"; backups+=("$f"); else backups+=("new:$f"); fi; done; }
restore() {
  for b in "${backups[@]}"; do
    if [[ $b == new:* ]]; then rm -f "${b#new:}"; else mv "$b.prove-bak" "$b"; fi
  done
  backups=()
}
# Edit a JSON file in place: json <file> <js expression over `d` that mutates it>.
json() { node -e "const fs=require('fs');const d=JSON.parse(fs.readFileSync('$1','utf8'));$2;fs.writeFileSync('$1',JSON.stringify(d,null,2)+'\n')"; }
expect_fail() { # name, expected pattern, command...
  local name=$1 pattern=$2; shift 2
  if "$@" >"$out" 2>&1; then echo "NOT CAUGHT  $name (passed)"; fail=1
  elif grep -qE "$pattern" "$out"; then
    # Show the violation the expected rule reported: the line after its FAIL header, or the matching line itself.
    local msg; msg=$(node -e 'const fs=require("fs");const lines=fs.readFileSync(process.argv[1],"utf8").split("\n");const re=new RegExp(process.argv[2]);for(let i=0;i<lines.length;i++){if(re.test(lines[i])){if(lines[i].startsWith("FAIL"))console.log(lines[i+1]?.trim()||lines[i]);else console.log(lines[i].trim());break;}}' "$out" "$pattern" | cut -c1-120)
    echo "caught      $name: $msg"
  else echo "NOT CAUGHT  $name (failed without /$pattern/: $(grep -m1 . "$out" | cut -c1-100))"; fail=1; fi
  restore
}
expect_pass() { # name, pattern the output must show, command...
  local name=$1 pattern=$2; shift 2
  if "$@" >"$out" 2>&1 && grep -qE "$pattern" "$out"; then echo "accepted    $name"
  else echo "NOT ACCEPTED $name: $(grep -m1 -E 'FAIL|Error|^  \S' "$out" | cut -c1-120)"; fail=1; fi
  restore
}
seed() { # name, file, appended content, expected pattern, command...
  local name=$1 file=$2 content=$3 pattern=$4; shift 4
  backup "$file"; printf '%s' "$content" >> "$file"
  expect_fail "$name" "$pattern" "$@"
}

seed "wire event built outside protocol/" src/clients/tui/draft.ts $'\nexport const seededWire = { sessionId: "s", seq: 1, turnId: null, type: "text_delta", payload: {} };\n' '\[one-projection\]' node scripts/check-rules.mjs
seed "file named service" src/app/seeded-service.ts $'export const seeded = 1;\n' '\[names-are-jobs\]' node scripts/check-rules.mjs
seed "new unused export" src/app/settings.ts $'\nexport function seededUnusedExport() { return 1; }\n' '\[unused-exports\]' node scripts/check-rules.mjs
seed "leaf reducer imported outside foldFact" src/app/settings.ts $'\nimport { reduceDirectQueue } from "../session/queue-state.js";\nexport const seededFold = reduceDirectQueue;\n' '\[one-fold\]' node scripts/check-rules.mjs
seed "leaf-reducer module namespace-imported outside foldFact" src/app/settings.ts $'\nimport * as q from "../session/queue-state.js";\nexport const seededFold = q;\n' '\[one-fold\]' node scripts/check-rules.mjs
seed "leaf-reducer module dynamically imported outside foldFact" src/app/settings.ts $'\nexport const seededFold = import("../session/queue-state.js");\n' '\[one-fold\]' node scripts/check-rules.mjs
seed "app/ reads a session log" src/app/settings.ts $'\nexport const seededReader = readFactLines;\n' '\[log-readers\]' node scripts/check-layers.mjs
seed "engine imports app (layer direction)" src/engine/turn.ts $'\nimport "../app/settings.js";\n' '\[layer-direction\]' node scripts/check-layers.mjs
seed "duplicate basename" src/app/turn.ts $'export const seededTurn = 1;\n' '\[duplicate-basenames\]' node scripts/check-rules.mjs
seed "folder fan-out exceeds ceiling" src/config/settings/seeded-fanout.ts $'export const seeded = 1;\n' '\[folder-fanout\]' node scripts/check-complexity.mjs
seed "file never reached from app/cli.ts" src/app/seeded-dead.ts $'export const dead = 1;\n' 'unreached from src/app/cli.ts: src/app/seeded-dead\.ts' node scripts/check-reachability.mjs
# Match the seeded diagnostic too: pre-existing dead code must not satisfy this proof.
for edge in \
  'import type { SeededDead } from "./seeded-type-dead.js";' \
  'import { type SeededDead } from "./seeded-type-dead.js";' \
  'export type { SeededDead } from "./seeded-type-dead.js";' \
  'export { type SeededDead } from "./seeded-type-dead.js";'; do
  backup src/app/cli.ts src/app/seeded-type-dead.ts
  printf '\n%s\n' "$edge" >> src/app/cli.ts
  printf 'export class SeededDead {}\n' > src/app/seeded-type-dead.ts
  expect_fail "runtime file linked only by $edge" \
    'unreached from src/app/cli.ts: src/app/seeded-type-dead\.ts' node scripts/check-reachability.mjs
done
seed "engine callback writes the log" src/session/conversation.ts $'\nexport const seededCallback = (journal: ConversationJournal): Pick<import("../engine/index.js").TurnDeps, "onTurnBoundary"> => ({ onTurnBoundary: () => void journal.commit([]) });\n' '\[engine-callback-writes\].*|TurnDeps.onTurnBoundary writes' node scripts/check-engine-callbacks.mjs
seed "run-budget callback writes through a port (audit F1 shape)" src/session/run-budget.ts $'\nexport const seededCost = (accept: (fact: DirectRequestCostFact) => void): Pick<TurnBudgetOptions, "toolEffect"> => ({ toolEffect: () => { accept({} as DirectRequestCostFact); return undefined; } });\ntype TurnBudgetOptions = NonNullable<TurnDeps["budget"]>;\n' 'TurnBudget.toolEffect writes' node scripts/check-engine-callbacks.mjs
seed "file over 500 lines" src/app/seeded-big.ts "$(for i in $(seq 520); do echo "export const v$i = $i;"; done)" '\[file-size\]' node scripts/check-complexity.mjs
seed "unallowlisted root file" seeded-root-file.md $'seeded\n' '\[root-files\]' node scripts/check-root.mjs
seed "failure explains the rule" src/app/seeded-service.ts $'export const seeded = 1;\n' 'Why this rule exists: .*pattern a file is' node scripts/check-rules.mjs

# Judgement route: deviations may be recorded, but only with a reason that holds.
edge='engine/turn.ts -> app/settings.ts (engine -> app)'
backup scripts/layer-allowlist.json; json scripts/layer-allowlist.json "d.push('src/$edge')"
expect_fail "allowlist grew by a bare entry" 'new bare entry' node scripts/check-baselines.mjs
backup scripts/layer-allowlist.json; json scripts/layer-allowlist.json "d.push({edge:'$edge',reason:'needed'})"
expect_fail "allowlist grew with a placeholder reason" 'too short|placeholder' node scripts/check-baselines.mjs
backup scripts/layer-allowlist.json; json scripts/layer-allowlist.json "d.push({edge:'$edge',reason:'todo: this is needed for now, will fix it later on'})"
expect_fail "exception with a placeholder reason (gate itself)" 'placeholder reason' node scripts/check-layers.mjs
ceiling='src/tools/system/shell.ts'
backup scripts/complexity-budget.json; json scripts/complexity-budget.json "d.fileCeilings['$ceiling'].lines+=50"
expect_fail "ceiling raised without a new reason" 'reason is unchanged' node scripts/check-baselines.mjs
backup scripts/complexity-budget.json; json scripts/complexity-budget.json "d.maxLines=600"
expect_fail "global line limit raised" 'maxLines rose' node scripts/check-baselines.mjs
folder='src/tools'
backup scripts/complexity-budget.json; json scripts/complexity-budget.json "d.folderCeilings['$folder'].files+=5"
expect_fail "folder ceiling raised without a new reason" 'reason is unchanged' node scripts/check-baselines.mjs
backup scripts/complexity-budget.json; json scripts/complexity-budget.json "d.maxFolderFiles+=5"
expect_fail "global folder file limit raised" 'maxFolderFiles rose' node scripts/check-baselines.mjs
backup scripts/complexity-budget.json; json scripts/complexity-budget.json "d.maxLayerEdges+=1"
expect_fail "edge budget raised without a reasoned edge" 'maxLayerEdges rose' node scripts/check-baselines.mjs
backup scripts/rule-baseline.json; json scripts/rule-baseline.json "d.duplicateBasenames.push('app/turn.ts')"
expect_fail "duplicate basename allowlist grew by a bare entry" 'new bare entry' node scripts/check-baselines.mjs
backup scripts/rule-baseline.json; json scripts/rule-baseline.json "d.duplicateBasenames.push({file:'app/turn.ts',reason:'needed'})"
expect_fail "duplicate basename with placeholder reason" 'too short|placeholder' node scripts/check-baselines.mjs

backup src/engine/turn.ts scripts/layer-allowlist.json scripts/complexity-budget.json
printf '\nimport "../app/settings.js";\n' >> src/engine/turn.ts
json scripts/layer-allowlist.json "d.push({edge:'$edge',reason:'Seeded by prove-checks: the engine reads one setting here; a port would add more indirection than the edge costs.'})"
json scripts/complexity-budget.json "d.maxLayerEdges+=1"
expect_pass "reasoned layer edge is accepted and shown to the reviewer" 'Recorded deviations added in this change \(1\)' \
  bash -c 'node scripts/check-layers.mjs && node scripts/check-complexity.mjs && node scripts/check-baselines.mjs'
backup scripts/complexity-budget.json
json scripts/complexity-budget.json "const c=d.fileCeilings['$ceiling'];c.lines+=50;c.reason+=' Seeded by prove-checks: the new lines extend the same job.'"
expect_pass "raised ceiling with a rewritten reason is accepted" "ceiling [0-9]+ -> [0-9]+" node scripts/check-baselines.mjs
backup scripts/complexity-budget.json
json scripts/complexity-budget.json "const c=d.folderCeilings['$folder'];c.files+=5;c.reason+=' Seeded by prove-checks: the new files extend the same module.'"
expect_pass "raised folder ceiling with a rewritten reason is accepted" "ceiling [0-9]+ -> [0-9]+" node scripts/check-baselines.mjs
backup src/app/seeded-dup.ts scripts/rule-baseline.json
printf 'export const seededDup = 1;\n' >> src/app/seeded-dup.ts
printf 'export const seededDup = 2;\n' >> src/tools/seeded-dup.ts
backups+=("new:src/tools/seeded-dup.ts")
json scripts/rule-baseline.json "d.duplicateBasenames.push({file:'app/seeded-dup.ts',reason:'Seeded by prove-checks: duplicate file allowed for testing reasons.'},{file:'tools/seeded-dup.ts',reason:'Seeded by prove-checks: duplicate file allowed for testing reasons.'})"
expect_pass "reasoned duplicate basenames are accepted and shown to reviewer" 'duplicate-basenames' \
  bash -c 'node scripts/check-rules.mjs && node scripts/check-baselines.mjs'

backup src/session/conversation.ts scripts/rule-baseline.json
printf '\nexport const seededCallback = (journal: ConversationJournal): Pick<import("../engine/index.js").TurnDeps, "onTurnBoundary"> => ({ onTurnBoundary: () => void journal.commit([]) });\n' >> src/session/conversation.ts
json scripts/rule-baseline.json "d.engineCallbackWrites.push({callback:'TurnDeps.onTurnBoundary',reason:'Seeded by prove-checks: the boundary write is its own receipt and lands at a settled boundary.'})"
expect_pass "reasoned engine-callback writer is accepted and shown to the reviewer" 'engine-callback-writes' \
  bash -c 'node scripts/check-engine-callbacks.mjs && node scripts/check-baselines.mjs'

rm -f "$out"
exit $fail
