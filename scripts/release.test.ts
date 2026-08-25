import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

const releaseScript = resolve('scripts/release.sh');

function runRelease(...args: string[]) {
  const result = spawnSync('bash', [releaseScript, ...args], {
    encoding: 'utf8',
  });

  return {
    status: result.status,
    output: `${result.stdout}${result.stderr}`,
  };
}

it('documents the non-interactive release path and CI publish default', () => {
  const result = runRelease('--help');

  expect(result.status).toBe(0);
  expect(result.output).toContain('--minor --push --non-interactive');
  expect(result.output).toContain('--publish-local');
  expect(result.output).toContain('delegated to the GitHub Actions Trusted');
});

it('rejects non-interactive mode without an explicit push decision', () => {
  const result = runRelease('--non-interactive');

  expect(result.status).toBe(1);
  expect(result.output).toContain('--non-interactive requires either --push or --no-push');
});

it('rejects combining a version with a release selector before touching the repo', () => {
  const result = runRelease('--minor', '1.2.3');

  expect(result.status).toBe(1);
  expect(result.output).toContain('Specify either VERSION or a release selector');
});

it('rejects conflicting push modes before touching the repo', () => {
  const result = runRelease('--push', '--no-push');

  expect(result.status).toBe(1);
  expect(result.output).toContain('Specify only one of --push or --no-push');
});
