import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { afterAll, beforeAll, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const workflow = parse(await readFile(path.join(root, '.github/workflows/publish.yml'), 'utf8'));
const publishCommand = workflow.jobs.publish.steps.find(
  (step: { name: string }) => step.name === 'Publish package',
).run;
const [command, ...publishArgs] = publishCommand.trim().split(/\s+/);
let registry: string;
let requests = 0;
// A real loopback sink is a second safety boundary: even a dry-run regression
// cannot reach npm. Any registry access is unexpected, including reads.
const server = createServer((_request, response) => {
  requests++;
  response.writeHead(403).end('Publication is forbidden in this fixture');
});

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  registry = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

async function run(cwd: string, executable: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env: {
        ...process.env,
        // Exercise publishing-job capabilities locally too. The publish
        // child must isolate auth even when pnpm is only doing a dry-run.
        GITHUB_ACTIONS: 'true',
        ACTIONS_ID_TOKEN_REQUEST_URL: `${registry}/oidc`,
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'fixture-not-a-secret',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_AUTHOR_NAME: 'Release fixture',
        GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
        GIT_COMMITTER_NAME: 'Release fixture',
        GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
        GITHUB_REF: '',
        GITHUB_EVENT_NAME: '',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, output }));
  });
}

// These are process/filesystem/workflow journeys, not calls into guard internals:
// real Git refs -> production build-info writer -> workflow's pnpm publish command.
const cases = [
  ['tag push', 'valid', true],
  ['manual dispatch', 'valid', true],
  ['manual dispatch', 'annotated tag', true],
  ['tag push', 'untagged', false],
  ['tag push', 'untagged write path', false],
  ['manual dispatch', 'untagged', false],
  ['manual dispatch', 'untagged write path', false],
  ['manual dispatch', 'wrong version tag', false],
  ['manual dispatch', 'tag added after development build', false],
  ['manual dispatch', 'dirty build', false],
  ['manual dispatch', 'dirty checkout after build', false],
  ['tag push', 'trigger tag mismatch', false],
  ['manual dispatch', 'missing metadata', false],
  ['manual dispatch', 'malformed metadata', false],
  ['manual dispatch', 'release false', false],
  ['manual dispatch', 'version mismatch', false],
  ['manual dispatch', 'stale commit', false],
  ['manual dispatch', 'missing Git', false],
] as const;

it.each(cases)(
  '%s: %s (accepted=%s)',
  async (route, scenario, accepted) => {
    expect(command).toBe('pnpm');
    expect(publishArgs[0]).toBe('publish');
    expect(workflow.on.push.tags).toContain('v*');
    expect(workflow.on).toHaveProperty('workflow_dispatch');
    const cwd = await mkdtemp(path.join(tmpdir(), 'term2-publish-identity-'));
    try {
      const git = async (...args: string[]) => {
        const result = await run(cwd, 'git', args);
        expect(result.code, result.output).toBe(0);
        return result.output.trim();
      };
      await mkdir(path.join(cwd, 'scripts'));
      await mkdir(path.join(cwd, 'dist'));
      // Use the real package lifecycle wiring, not a test-only invocation.
      await writeFile(
        path.join(cwd, 'package.json'),
        JSON.stringify({
          name: manifest.name,
          version: manifest.version,
          type: 'module',
          files: manifest.files,
          scripts: manifest.scripts.prepublishOnly ? { prepublishOnly: manifest.scripts.prepublishOnly } : {},
        }),
      );
      await writeFile(path.join(cwd, '.gitignore'), 'dist/\n*.tgz\n');
      await writeFile(path.join(cwd, 'dist/cli.js'), '// fixture payload\n');
      await copyFile(path.join(root, 'scripts/write-build-info.mjs'), path.join(cwd, 'scripts/write-build-info.mjs'));
      if (manifest.scripts.prepublishOnly) {
        await copyFile(
          path.join(root, 'scripts/check-release-identity.mjs'),
          path.join(cwd, 'scripts/check-release-identity.mjs'),
        );
      }
      await git('init', '--quiet');
      await git('add', '.');
      await git(
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '--quiet',
        '-m',
        'fixture source',
      );
      const tag = `v${manifest.version}`;
      if (!['untagged', 'untagged write path', 'tag added after development build'].includes(scenario)) {
        if (scenario === 'annotated tag')
          await git('-c', 'tag.gpgsign=false', 'tag', '-a', tag, '-m', 'fixture release');
        else await git('-c', 'tag.gpgsign=false', 'tag', scenario === 'wrong version tag' ? 'v0.0.0-wrong' : tag);
      }
      if (scenario === 'dirty build') await writeFile(path.join(cwd, 'untracked.txt'), 'dirty');
      const build = await run(cwd, process.execPath, ['scripts/write-build-info.mjs']);
      expect(build.code, build.output).toBe(0);
      if (scenario === 'tag added after development build') await git('-c', 'tag.gpgsign=false', 'tag', tag);
      if (scenario === 'dirty checkout after build') await writeFile(path.join(cwd, 'untracked.txt'), 'dirty');
      const infoPath = path.join(cwd, 'dist/build-info.json');
      if (scenario === 'missing metadata') await rm(infoPath);
      if (scenario === 'malformed metadata') await writeFile(infoPath, '{');
      if (['release false', 'version mismatch', 'stale commit'].includes(scenario)) {
        const info = JSON.parse(await readFile(infoPath, 'utf8'));
        if (scenario === 'release false') info.release = false;
        if (scenario === 'version mismatch') info.version = '0.0.0-wrong';
        if (scenario === 'stale commit') info.commit = '0'.repeat(40);
        await writeFile(infoPath, JSON.stringify(info));
      }
      // Match checkout@v7's detached HEAD for the tag route. Manual recovery may
      // instead select a branch, provided its HEAD really is the tagged release.
      if (route === 'tag push') await git('switch', '--detach', '--quiet');
      if (scenario === 'missing Git') await rm(path.join(cwd, '.git'), { recursive: true });
      const beforeRequests = requests;
      const result = await run(
        cwd,
        command,
        [...publishArgs, ...(scenario === 'untagged write path' ? [] : ['--dry-run']), '--registry', registry],
        {
          GITHUB_EVENT_NAME: route === 'tag push' ? 'push' : 'workflow_dispatch',
          GITHUB_REF:
            route === 'tag push'
              ? `refs/tags/${scenario === 'trigger tag mismatch' ? 'v0.0.0-wrong' : tag}`
              : 'refs/heads/main',
          npm_config_registry: registry,
          NPM_CONFIG_REGISTRY: registry,
          ACTIONS_ID_TOKEN_REQUEST_URL: '',
          ACTIONS_ID_TOKEN_REQUEST_TOKEN: '',
          NODE_AUTH_TOKEN: '',
          NPM_TOKEN: '',
          NPM_CONFIG_USERCONFIG: '/dev/null',
        },
      );
      expect(requests).toBe(beforeRequests);
      if (accepted) {
        expect(result.code, result.output).toBe(0);
        expect(result.output).toContain('[release-identity] OK');
        expect(JSON.parse(await readFile(infoPath, 'utf8')).version).toBe(manifest.version);
      } else {
        expect(result.code, result.output).not.toBe(0);
        expect(result.output).toContain('[release-identity] Refusing publication');
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
  30_000,
);
