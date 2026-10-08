#!/usr/bin/env node
// Evidence-driven development experiment: no permanent unit tests.
// See docs/experiments/evidence-driven-development/README.md.
//
// Fails when the Git index holds a test file that the default Vitest config would run
// (the old unit tier), other than the fixed list of static repository guards below.
// Untracked files are ignored, so temporary tests written during development are fine
// as long as they are not committed. Integration, e2e and provider black-box tests are
// separate tiers and are not checked here; disguising a unit test as one of them is a
// review finding, not something this script tries to detect.
//
// The guards scan source text and enforce architecture rules, like a lint rule. Adding
// one to this list needs the user's approval; it is not a way around the experiment.
import { execFileSync } from 'node:child_process';

export const GUARDS = new Set([
  'source/compatibility-retirement.guard.test.ts',
  'source/contracts/model-contract-retirement.test.ts',
  'source/core/core-boundary.test.ts',
  'source/no-manual-stdout-sync.guard.test.ts',
  'source/services/application-stream-boundary.test.ts',
  'source/theme/no-raw-colors.guard.test.ts',
  'source/tools/system/run-code/run-code-runtime-boundary.test.ts',
]);

export function isUnitTest(file) {
  if (!/^(source|scripts|docs)\//.test(file)) return false;
  if (file.startsWith('scripts/provider-black-box/')) return false;
  if (/\.(e2e|integration)\./.test(file)) return false;
  return /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/.test(file);
}

const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const offenders = tracked.filter((file) => isUnitTest(file) && !GUARDS.has(file));

if (offenders.length) {
  console.error('Permanent unit tests are not allowed during the evidence-driven development experiment:');
  for (const file of offenders) console.error(`  ${file}`);
  console.error(
    'Keep temporary tests untracked, or move a real cross-module check to the integration tier.\n' +
      'See docs/experiments/evidence-driven-development/README.md.',
  );
  process.exit(1);
}
