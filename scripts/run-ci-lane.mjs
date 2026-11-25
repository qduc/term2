import { execFile, spawn, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Each CI lane owns exactly one test tier; heavy tiers run in parallel shards via --shard=i/n.
const tiers = {
  quality: ['guards', 'vitest.config.ts'],
  integration: ['integration', 'vitest.integration.config.ts'],
  e2e: ['e2e', 'vitest.e2e.config.ts'],
  'provider-black-box': ['provider', 'vitest.provider-black-box.config.ts'],
};

const lane = process.argv[2];
const listOnly = process.argv.includes('--list');
if (!Object.hasOwn(tiers, lane)) {
  throw new Error(`Expected a CI lane: ${Object.keys(tiers).join(', ')}`);
}

function parseShard(argv) {
  const flag = argv.find((arg) => arg.startsWith('--shard='));
  if (!flag) return { index: 1, total: 1 };
  const match = /^--shard=(\d+)\/(\d+)$/.exec(flag);
  if (!match) throw new Error(`Invalid shard flag "${flag}"; expected --shard=<index>/<total>`);
  const index = Number(match[1]);
  const total = Number(match[2]);
  if (!Number.isInteger(index) || !Number.isInteger(total) || total < 1 || index < 1 || index > total) {
    throw new Error(`Invalid shard "${flag}": index must be between 1 and total`);
  }
  return { index, total };
}

const shard = parseShard(process.argv.slice(3));
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
const [tier, config] = tiers[lane];

// The build and inventory discovery are independent; overlap them before running tests.
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

const { stdout } = await promisify(execFile)(
  process.execPath,
  [vitest, 'list', '--config', config, '--filesOnly', '--json'],
  { env, encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024 },
);
const allFiles = JSON.parse(stdout)
  .map(({ file }) => relative(process.cwd(), file).replaceAll('\\', '/'))
  .sort();
if (allFiles.length === 0 || new Set(allFiles).size !== allFiles.length) {
  throw new Error(`Invalid ${tier} inventory`);
}
// Deterministic round-robin partition over the sorted file list guarantees every file runs in
// exactly one shard (no cache-dependent drift between shards) while spreading sibling files
// that share a filename prefix across different shards.
const files = shard.total === 1 ? allFiles : allFiles.filter((_, index) => index % shard.total === shard.index - 1);
const plan = [{ tier, config, total: allFiles.length, shard, files }];
console.log(JSON.stringify({ lane, shard, maxWorkers, plan }, null, 2));
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
    console.error(
      `[ci] ${lane} (${shard.index}/${shard.total}) failed: ${result.error?.message ?? result.signal ?? result.status}`,
    );
    process.exitCode = 1;
  }
}
