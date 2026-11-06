import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const vitestCli = path.join(path.dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
const setupFile = path.join(import.meta.dirname, 'vitest-cache-isolation.ts');
const globalSetupFile = path.join(import.meta.dirname, 'vitest-cache-global-setup.ts');

// Cross the runner/process boundary: assertions inside a suite cannot establish
// whether its own setup directory was disposed after the suite finished.
it('disposes owned caches after tests and collection errors while preserving an external cache', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'term2-cache-lifecycle-'));
  try {
    for (const scenario of ['pass', 'fail', 'collection-error', 'external'] as const) {
      const fixture = path.join(root, scenario);
      const temp = path.join(fixture, 'tmp');
      const external = path.join(fixture, 'external');
      await mkdir(temp, { recursive: true });
      await mkdir(external);
      await writeFile(path.join(external, 'sentinel'), 'keep');
      await writeFile(
        path.join(fixture, 'vitest.config.mjs'),
        `export default ${JSON.stringify({
          test: {
            include: ['*.test.ts'],
            setupFiles: [setupFile],
            globalSetup: [globalSetupFile],
            environment: 'node',
            maxWorkers: 2,
          },
        })}`,
      );
      for (const name of ['a', 'b']) {
        await writeFile(
          path.join(fixture, `${name}.test.ts`),
          `import { afterAll, it, expect } from ${JSON.stringify(path.join(path.dirname(vitestCli), 'dist/index.js'))};
import { writeFileSync } from 'node:fs';
import path from 'node:path';
${scenario === 'collection-error' ? "throw new Error('intentional collection failure');" : ''}
it('uses the isolated cache', () => {
  expect(process.env.TERM2_CACHE_DIR).toBeTruthy();
  writeFileSync(path.join(process.env.TERM2_CACHE_DIR, '${name}'), 'written');
  expect(${JSON.stringify(scenario)}).not.toBe('fail');
});
afterAll(() => {
  writeFileSync(path.join(process.env.TERM2_CACHE_DIR, '${name}-teardown'), 'written');
});`,
        );
      }
      const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: temp, NODE_ENV: 'test' };
      delete env.TERM2_CACHE_DIR;
      if (scenario === 'external') env.TERM2_CACHE_DIR = external;
      let code = 0;
      let output = '';
      try {
        const result = await execFileAsync(process.execPath, [vitestCli, 'run', '--reporter=dot'], {
          cwd: fixture,
          env,
          timeout: 20_000,
        });
        output = result.stdout + result.stderr;
      } catch (error) {
        const failure = error as { code: number; stdout: string; stderr: string };
        code = failure.code;
        output = failure.stdout + failure.stderr;
      }
      const failed = scenario === 'fail' || scenario === 'collection-error';
      expect(code, output).toBe(failed ? 1 : 0);
      expect(output).toContain(failed ? '2 failed' : '2 passed');
      expect(
        (await readdir(temp)).filter((name) => name.startsWith('term2-test-cache-')),
        `${scenario}: ${output}`,
      ).toEqual([]);
      expect(await readFile(path.join(external, 'sentinel'), 'utf8')).toBe('keep');
      if (scenario === 'external') {
        expect(await readFile(path.join(external, 'a'), 'utf8')).toBe('written');
        expect(await readFile(path.join(external, 'b'), 'utf8')).toBe('written');
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
