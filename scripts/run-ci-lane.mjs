import { execFileSync, spawnSync } from 'node:child_process';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// Keep the existing four check names and runner count. Discover through each
// tier's real Vitest configuration so new files are assigned automatically.
const lanes = ['test', 'integration', 'e2e', 'provider-black-box'];
const lane = process.argv[2];
const listOnly = process.argv.includes('--list');
if (!lanes.includes(lane)) throw new Error(`Expected a CI lane: ${lanes.join(', ')}`);
// Keep the reported plan and every Vitest project on the same worker count.
const maxWorkers = 3;
const env = { ...process.env, CI: '1', NODE_ENV: 'test' };
// Dependencies are installed and verified by the setup action. Invoke the
// locked executable directly; pnpm exec may relink dependencies before a run.
const vitest = fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url));
const tiers = [
  ['guards', 'vitest.config.ts'],
  ['integration', 'vitest.integration.config.ts'],
  ['e2e', 'vitest.e2e.config.ts'],
  ['provider', 'vitest.provider-black-box.config.ts'],
];

function owner(tier, file) {
  if (tier === 'guards') return 'test';
  if (tier === 'integration')
    return /^source\/cli(?:-headless)?\.integration\.test\.ts$/.test(file) ? 'test' : 'integration';
  if (tier === 'e2e') return 'e2e';
  if (file.endsWith('/provider-session-stateless.blackbox.ts')) return 'integration';
  if (/\/(?:provider-ordinary-safety|reference-approval)\.blackbox\.ts$/.test(file)) return 'test';
  if (/\/provider-session-responses(?:-tools|-failures)?\.blackbox\.ts$/.test(file)) return 'e2e';
  return 'provider-black-box';
}

const plan = tiers.map(([tier, config]) => {
  const files = JSON.parse(
    execFileSync(process.execPath, [vitest, 'list', '--config', config, '--filesOnly', '--json'], {
      env,
      encoding: 'utf8',
      timeout: 60_000,
      maxBuffer: 8 * 1024 * 1024,
    }),
  ).map(({ file }) => relative(process.cwd(), file).replaceAll('\\', '/'));
  if (files.length === 0 || new Set(files).size !== files.length) throw new Error(`Invalid ${tier} inventory`);
  return { tier, config, total: files.length, files: files.filter((file) => owner(tier, file) === lane).sort() };
});
console.log(JSON.stringify({ lane, maxWorkers, plan }, null, 2));
if (!listOnly) {
  const result = spawnSync(process.execPath, [vitest, 'run', '--config', 'vitest.ci.config.ts', '--reporter=verbose'], {
    env: {
      ...env,
      TERM2_CI_PLAN: JSON.stringify(plan),
      TERM2_CI_MAX_WORKERS: String(maxWorkers),
      TERM2_CI_PREBUILT_CLI: '1',
    },
    stdio: 'inherit',
  });
  // Run all assigned files even after a test fails. The single invocation
  // reports collection/unhandled errors and propagates its failure status.
  if (result.status !== 0 || result.error) {
    console.error(`[ci] ${lane} failed: ${result.error?.message ?? result.signal ?? result.status}`);
    process.exitCode = 1;
  }
}
