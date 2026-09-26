import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { writeBuildInfo } from './write-build-info.mjs';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function buildInfo({ tags = '', dirty = '', hash = '0123456789abcdef0123456789abcdef01234567' } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'term2-build-info-'));
  roots.push(root);
  const dist = path.join(root, 'dist');
  await mkdir(dist);
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ version: '0.27.0' }));
  const runGit = (args: string[]) => {
    if (args[0] === 'rev-parse') return hash;
    if (args[0] === 'status') return dirty;
    if (args[0] === 'tag') return tags;
    throw new Error(`Unexpected git args: ${args.join(' ')}`);
  };
  await writeBuildInfo({ root, dist, runGit });
  return JSON.parse(await readFile(path.join(dist, 'build-info.json'), 'utf8')) as {
    version: string;
    commit: string | null;
    release: boolean;
    limitation: string | null;
  };
}

it('emits the plain package version for a clean exact public tag', async () => {
  await expect(buildInfo({ tags: 'v0.27.0' })).resolves.toMatchObject({
    version: '0.27.0',
    release: true,
    limitation: null,
  });
});

it('uses the development version and HEAD hash when untagged', async () => {
  await expect(buildInfo()).resolves.toMatchObject({ version: '0.27.0-dev+0123456', release: false });
});

it('does not treat a wrong-version exact tag as a release', async () => {
  await expect(buildInfo({ tags: 'v0.26.9' })).resolves.toMatchObject({
    version: '0.27.0-dev+0123456',
    release: false,
  });
});

it('treats a dirty exact-tagged commit as a development build', async () => {
  await expect(buildInfo({ tags: 'v0.27.0', dirty: ' M source/cli.tsx' })).resolves.toMatchObject({
    version: '0.27.0-dev+0123456',
    release: false,
  });
});

it('reports a non-release limitation when Git cannot provide HEAD', async () => {
  await expect(buildInfo({ hash: null as unknown as string })).resolves.toMatchObject({
    version: '0.27.0-dev (commit hash unavailable; built outside a Git checkout)',
    commit: null,
    release: false,
    limitation: expect.stringContaining('commit hash unavailable'),
  });
});
