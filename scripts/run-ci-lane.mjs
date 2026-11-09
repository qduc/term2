import { execFile, spawn, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Keep the existing behavioral check names; quality owns static guards. Discover through each
// tier's real Vitest configuration so new files are assigned automatically.
const lanes = ['quality', 'test', 'integration', 'e2e', 'provider-black-box'];
const lane = process.argv[2];
const listOnly = process.argv.includes('--list');
if (!lanes.includes(lane)) throw new Error(`Expected a CI lane: ${lanes.join(', ')}`);
// Keep the reported plan and every Vitest project on the same worker count.
const maxWorkers = 3;
const env = {
  ...process.env,
  CI: '1',
  NODE_ENV: 'test',
  // Behavioral lanes drive term2's production entry module against isolated fixtures.
  TERM2_TEST_CLI: resolve('dist/src/app/cli.js'),
};
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
  if (tier === 'guards') return 'quality';
  if (tier === 'integration')
    return /^tests\/cli\/cli(?:-headless)?\.integration\.test\.ts$/.test(file) ? 'test' : 'integration';
  if (tier === 'e2e') {
    // The e2e lane outgrew the others (~100s of cases on 2026-11-08 vs ~50s for test), so its
    // heaviest files run in the test lane. Not provider-black-box: its heavy cases have ~40s
    // deadlines that PTY-driven e2e load pushed over. See the testing skill before rebalancing.
    if (/^tests\/cli\/(?:slash-commands|coalesced-enter|resume-picker)\.e2e\.test\.ts$/.test(file)) return 'test';
    return 'e2e';
  }
  if (file.endsWith('/provider-session-stateless.blackbox.ts')) return 'integration';
  if (/\/(?:provider-ordinary-safety|reference-approval)\.blackbox\.ts$/.test(file)) return 'test';
  if (/\/provider-session-responses(?:-tools|-failures)?\.blackbox\.ts$/.test(file)) return 'test';
  return 'provider-black-box';
}

// The build and the four inventories are independent; sequentially they cost ~7s before any
// test ran (2026-11-09: ~2s of `vitest list`, ~5s of build), so they overlap.
const build =
  !listOnly && lane !== 'quality'
    ? new Promise((done, fail) => {
        const child = spawn(process.execPath, ['scripts/build.mjs'], { env, stdio: 'inherit' });
        child.on('error', (error) => fail(new Error(`CLI build failed: ${error.message}`)));
        child.on('exit', (code, signal) =>
          code === 0 ? done() : fail(new Error(`CLI build failed: ${signal ?? code}`)),
        );
      })
    : Promise.resolve();
// Rejection is handled by the `await build` below; this only avoids an unhandled-rejection crash first.
build.catch(() => {});
const plan = await Promise.all(
  tiers.map(async ([tier, config]) => {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [vitest, 'list', '--config', config, '--filesOnly', '--json'],
      { env, encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024 },
    );
    const files = JSON.parse(stdout).map(({ file }) => relative(process.cwd(), file).replaceAll('\\', '/'));
    if (files.length === 0 || new Set(files).size !== files.length) throw new Error(`Invalid ${tier} inventory`);
    return { tier, config, total: files.length, files: files.filter((file) => owner(tier, file) === lane).sort() };
  }),
);
console.log(JSON.stringify({ lane, maxWorkers, plan }, null, 2));
await build;
if (!listOnly) {
  const result = spawnSync(process.execPath, [vitest, 'run', '--config', 'vitest.ci.config.ts', '--reporter=verbose'], {
    env: {
      ...env,
      TERM2_CI_PLAN: JSON.stringify(plan),
      TERM2_CI_MAX_WORKERS: String(maxWorkers),
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
