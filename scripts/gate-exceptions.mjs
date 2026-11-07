#!/usr/bin/env node
// List every recorded deviation from a repository gate, with the reason it was accepted.
// Use it for precedent before recording a new exception, and as a reviewer to audit the ones that exist.
//   node scripts/gate-exceptions.mjs            all rules
//   node scripts/gate-exceptions.mjs file-size  one rule (ids: see scripts/gates/rules.mjs)
//   --legacy                                    also list every grandfathered entry, not just their count
import { RULES, readDeviations, readWorkingTree } from './gates/rules.mjs';

const args = process.argv.slice(2);
const showLegacy = args.includes('--legacy');
const only = args.find((arg) => !arg.startsWith('--'));
if (only && !RULES[only]) {
  console.error(`unknown rule "${only}". Rules: ${Object.keys(RULES).join(', ')}`);
  process.exit(1);
}

const { deviations } = readDeviations(readWorkingTree);
for (const [id, rule] of Object.entries(RULES)) {
  if (only && id !== only) continue;
  const mine = deviations.filter((d) => d.rule === id);
  if (!rule.exceptions) {
    if (only) console.log(`${rule.title} [${id}]: no exception route; disagreements go to the user.`);
    continue;
  }
  const reasoned = mine.filter((d) => !d.legacy);
  const legacy = mine.filter((d) => d.legacy);
  console.log(
    `\n${rule.title} [${id}] — ${reasoned.length} with reasons, ${legacy.length} legacy (${rule.exceptions.file})`,
  );
  console.log(`  why the rule exists: ${rule.why}`);
  for (const d of reasoned)
    console.log(
      `  - ${d.key}${d.lines ? ` (ceiling ${d.lines})` : ''}${d.files ? ` (ceiling ${d.files} files)` : ''}\n      ${
        d.reason
      }`,
    );
  if (legacy.length) {
    console.log(`  legacy entries: ${legacy[0].legacyReason ?? 'predate per-entry reasons.'}`);
    if (showLegacy || (only && legacy.length <= 30)) for (const d of legacy) console.log(`  - ${d.key}`);
  }
}
