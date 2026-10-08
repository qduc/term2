import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';

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

it('guards the root package from depending on an unpublished wire package', async () => {
  const manifest = JSON.parse(await readFile(resolve('package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  const registryHasVersion = vi.fn(async () => false);
  const version = manifest.dependencies?.['@qduc/agent-wire'];
  expect(version).toBeUndefined();
  if (version && !(await registryHasVersion(version))) throw new Error('root depends on unpublished @qduc/agent-wire');
  expect(registryHasVersion).not.toHaveBeenCalled();
});

// Release safety dry runs: the real script against a throwaway local bare repo.
// Git config is isolated so no user/global remote, hook or signing setting leaks in.
describe('release.sh refuses to tag or push an unsafe release', () => {
  const version = '0.32.0';
  const gitEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'release-dry-run',
    GIT_AUTHOR_EMAIL: 'dry@example.invalid',
    GIT_COMMITTER_NAME: 'release-dry-run',
    GIT_COMMITTER_EMAIL: 'dry@example.invalid',
    NO_COLOR: '1',
  };
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' }).trim();
  }

  function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'term2-release-'));
    roots.push(root);
    const seed = join(root, 'seed');
    const bare = join(root, 'bare.git');
    const work = join(root, 'work');
    git(root, 'init', '-q', '-b', 'main', seed);
    writeFileSync(join(seed, 'package.json'), '{\n  "name": "release-fixture",\n  "version": "0.31.1"\n}\n');
    writeFileSync(join(seed, 'CHANGELOG.md'), '# Changelog\n\n## [0.31.1] - 2026-10-01\n');
    git(seed, 'add', '-A');
    git(seed, 'commit', '-qm', 'chore(release): v0.31.1');
    git(seed, 'tag', 'v0.31.1');
    git(root, 'clone', '-q', '--bare', seed, bare);
    git(root, 'clone', '-q', bare, work);
    // The script must only ever see this throwaway remote.
    expect(git(work, 'remote', '-v')).toBe(`origin\t${bare} (fetch)\norigin\t${bare} (push)`);
    return { root, bare, work };
  }

  function commitRelease(work: string) {
    writeFileSync(join(work, 'package.json'), `{\n  "name": "release-fixture",\n  "version": "${version}"\n}\n`);
    writeFileSync(
      join(work, 'CHANGELOG.md'),
      `# Changelog\n\n## [${version}] - 2026-10-08\n\n## [0.31.1] - 2026-10-01\n`,
    );
    git(work, 'add', 'package.json', 'CHANGELOG.md');
    git(work, 'commit', '-qm', `chore(release): v${version}`);
  }

  function release(work: string, push = '--push') {
    const result = spawnSync('bash', [releaseScript, version, push, '--non-interactive'], {
      cwd: work,
      env: gitEnv,
      encoding: 'utf8',
    });
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
  }

  const remoteTag = (bare: string) => git(bare, 'tag', '--list', `v${version}`);

  it('pushes main, then tags and pushes the release commit when every check passes', () => {
    const { bare, work } = fixture();
    commitRelease(work);
    git(work, 'push', '-q', 'origin', 'main');

    const result = release(work);

    expect(result.status, result.output).toBe(0);
    expect(git(bare, 'rev-parse', `v${version}^{commit}`)).toBe(git(work, 'rev-parse', 'HEAD'));
  });

  it('never pushes the tag when the main push is rejected', { timeout: 30_000 }, () => {
    const { bare, work } = fixture();
    commitRelease(work);
    const hook = join(bare, 'hooks', 'pre-receive');
    writeFileSync(
      hook,
      '#!/usr/bin/env bash\nwhile read -r _ _ ref; do [[ $ref == refs/heads/main ]] && exit 1; done\nexit 0\n',
    );
    chmodSync(hook, 0o755);

    const result = release(work);

    expect(result.status).toBe(1);
    expect(result.output).toContain(`Pushing main to origin failed; not pushing tag v${version}.`);
    expect(remoteTag(bare)).toBe('');
  });

  it('refuses to tag when HEAD is not the release commit for the version', () => {
    const { bare, work } = fixture();
    commitRelease(work);
    writeFileSync(join(work, 'late.txt'), 'late\n');
    git(work, 'add', 'late.txt');
    git(work, 'commit', '-qm', 'fix: landed after the release commit');
    git(work, 'push', '-q', 'origin', 'main');

    const result = release(work);

    expect(result.status).toBe(1);
    expect(result.output).toContain(`HEAD is not the release commit for v${version}`);
    expect(git(work, 'tag', '--list', `v${version}`)).toBe('');
    expect(remoteTag(bare)).toBe('');
  });

  it('refuses to reuse an existing tag that names another commit', () => {
    const { bare, work } = fixture();
    git(work, 'tag', `v${version}`);
    commitRelease(work);

    const result = release(work);

    expect(result.status).toBe(1);
    expect(result.output).toContain(`tag v${version} already exists on a different commit than HEAD`);
    expect(remoteTag(bare)).toBe('');
  });

  it('refuses to release from a branch other than main', () => {
    const { bare, work } = fixture();
    git(work, 'switch', '-q', '-c', `release/v${version}`);
    commitRelease(work);

    const result = release(work);

    expect(result.status).toBe(1);
    expect(result.output).toContain(`releases are cut from main; current branch is release/v${version}`);
    expect(git(bare, 'for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/tags')).toBe(
      'refs/heads/main\nrefs/tags/v0.31.1',
    );
  });

  it('refuses when local main is behind the remote after a fetch', () => {
    const { root, bare, work } = fixture();
    commitRelease(work);
    git(work, 'push', '-q', 'origin', 'main');
    const other = join(root, 'other');
    git(root, 'clone', '-q', bare, other);
    writeFileSync(join(other, 'other.txt'), 'other\n');
    git(other, 'add', 'other.txt');
    git(other, 'commit', '-qm', 'feat: someone else pushed');
    git(other, 'push', '-q', 'origin', 'main');

    const result = release(work);

    expect(result.status).toBe(1);
    expect(result.output).toContain('is not origin/main');
    expect(git(work, 'tag', '--list', `v${version}`)).toBe('');
    expect(remoteTag(bare)).toBe('');
  });

  it('refuses when the remote cannot be fetched', () => {
    const { bare, work } = fixture();
    commitRelease(work);
    renameSync(bare, `${bare}.offline`);

    const result = release(work, '--no-push');

    expect(result.status).toBe(1);
    expect(result.output).toContain('git fetch of origin main failed');
    expect(git(work, 'tag', '--list', `v${version}`)).toBe('');
  });
});
