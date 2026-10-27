import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));

async function run(cwd: string, env: NodeJS.ProcessEnv, command: string, args: string[]) {
  return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, output }));
  });
}

// Exercise the supported release-script continuation, not just pnpm publish:
// dirty pre-tag build -> release commit -> create/reuse tag -> build -> retries.
it.each(['create tag', 'existing tag', 'build failure'] as const)(
  '--publish-local resumes with %s before publication',
  async (scenario) => {
    const fixture = await mkdtemp(path.join(tmpdir(), 'term2-release-local-'));
    const cwd = path.join(fixture, 'source');
    const requests: string[] = [];
    const server = createServer((request, response) => {
      requests.push(request.method ?? '');
      request.resume();
      response.setHeader('Content-Type', 'application/json');
      if (request.url === '/-/whoami') {
        response.writeHead(200).end(JSON.stringify({ username: 'fixture' }));
      } else {
        // Never accept a publication, even if the caller accidentally omits a
        // dry-run flag. Auth/version probes and PUTs all stay on loopback.
        response.writeHead(request.method === 'PUT' ? 403 : 404).end('{"error":"fixture refuses publication"}');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing fixture registry');
      const registry = `http://127.0.0.1:${address.port}`;
      const config = path.join(fixture, 'npmrc');
      await writeFile(config, `registry=${registry}\n//127.0.0.1:${address.port}/:_authToken=fixture-not-a-secret\n`);
      const env = {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_AUTHOR_NAME: 'Release fixture',
        GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
        GIT_COMMITTER_NAME: 'Release fixture',
        GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
        GITHUB_REF: '',
        GITHUB_EVENT_NAME: '',
        npm_config_registry: registry,
        NPM_CONFIG_REGISTRY: registry,
        NPM_CONFIG_USERCONFIG: config,
        NODE_AUTH_TOKEN: '',
        NPM_TOKEN: '',
        FAIL_FIXTURE_BUILD: scenario === 'build failure' ? '1' : '',
      };
      const ok = async (command: string, ...args: string[]) => {
        const result = await run(cwd, env, command, args);
        expect(result.code, result.output).toBe(0);
        return result.output.trim();
      };
      await mkdir(path.join(cwd, 'scripts'), { recursive: true });
      await mkdir(path.join(cwd, 'dist'));
      for (const script of ['release.sh', 'write-build-info.mjs', 'check-release-identity.mjs']) {
        await copyFile(path.join(root, 'scripts', script), path.join(cwd, 'scripts', script));
      }
      // Minimal build payload: real production identity writer and filesystem
      // counter, not a mocked identity. Full application compilation is covered
      // by the normal build tier, independently of this caller-ordering journey.
      await writeFile(
        path.join(cwd, 'scripts/fixture-build.mjs'),
        `import { appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
appendFileSync('.git/local-build-count', 'build\\n');
if (process.env.FAIL_FIXTURE_BUILD) process.exit(23);
execFileSync(process.execPath, ['scripts/write-build-info.mjs'], { stdio: 'inherit' });
`,
      );
      const pkg = {
        name: manifest.name,
        version: '0.0.0',
        type: 'module',
        files: manifest.files,
        scripts: { build: 'node scripts/fixture-build.mjs', prepublishOnly: manifest.scripts.prepublishOnly },
      };
      await writeFile(path.join(cwd, 'package.json'), JSON.stringify(pkg));
      await writeFile(path.join(cwd, 'CHANGELOG.md'), '# Changelog\n\n## [0.0.0] - 2026-10-27\n');
      await writeFile(path.join(cwd, '.gitignore'), 'dist/\n*.tgz\n');
      await writeFile(path.join(cwd, 'dist/cli.js'), '// fixture payload\n');
      const commit = async (message: string) => {
        await ok('git', 'add', '.');
        await ok('git', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', 'commit', '-qm', message);
      };
      await ok('git', 'init', '-q', '-b', 'main');
      await commit('fixture base');
      const origin = path.join(fixture, 'origin.git');
      await ok('git', 'clone', '--quiet', '--bare', cwd, origin);
      await ok('git', 'remote', 'add', 'origin', origin);
      pkg.version = manifest.version;
      await writeFile(path.join(cwd, 'package.json'), JSON.stringify(pkg));
      await writeFile(path.join(cwd, 'CHANGELOG.md'), `# Changelog\n\n## [${pkg.version}] - 2026-10-27\n`);
      await ok(process.execPath, 'scripts/write-build-info.mjs');
      const before = JSON.parse(await readFile(path.join(cwd, 'dist/build-info.json'), 'utf8'));
      expect(before.release).toBe(false);
      await commit(`chore(release): v${pkg.version}`);
      if (scenario !== 'create tag') await ok('git', '-c', 'tag.gpgsign=false', 'tag', `v${pkg.version}`);
      const head = await ok('git', 'rev-parse', 'HEAD');
      const result = await run(cwd, env, 'bash', [
        'scripts/release.sh',
        pkg.version,
        '--no-push',
        '--non-interactive',
        '--publish-local',
      ]);
      expect(result.code, result.output).not.toBe(0); // Build failure or deliberate registry403, never a publish.
      expect(await ok('git', 'status', '--porcelain')).toBe('');
      expect(await ok('git', 'rev-parse', `v${pkg.version}^{commit}`)).toBe(head);
      expect(await readFile(path.join(cwd, '.git/local-build-count'), 'utf8')).toBe('build\n');
      if (scenario === 'build failure') {
        expect(result.code).toBe(23);
        expect(requests).toEqual([]); // No auth, version probe or publish retry after a failed build.
        expect(JSON.parse(await readFile(path.join(cwd, 'dist/build-info.json'), 'utf8'))).toEqual(before);
      } else {
        expect(JSON.parse(await readFile(path.join(cwd, 'dist/build-info.json'), 'utf8'))).toEqual({
          version: pkg.version,
          commit: head,
          release: true,
          limitation: null,
        });
        expect(result.output.match(/\[release-identity\] OK:/g)).toHaveLength(3);
        expect(requests.filter((method) => method === 'PUT')).toHaveLength(3);
        // Also show the resulting correctly tagged artifact is publishable via
        // the real lifecycle dry-run; only the fixture refuses actual writes.
        const puts = requests.filter((method) => method === 'PUT').length;
        await ok('pnpm', 'publish', '--access', 'public', '--no-git-checks', '--dry-run');
        expect(requests.filter((method) => method === 'PUT')).toHaveLength(puts);
      }
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      await rm(fixture, { recursive: true, force: true });
    }
  },
  45_000,
);
