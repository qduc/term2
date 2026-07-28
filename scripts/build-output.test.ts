import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
// @ts-expect-error -- build tooling is plain ESM, not typed
import { buildWithRollback, restorePreviousBuild } from './build-output.mjs';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const makeWorkspace = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'term2-build-output-'));
  temporaryDirectories.push(root);
  return { root, distDir: path.join(root, 'dist'), backupDir: path.join(root, 'dist.bak') };
};

const writeBuild = async (directory: string, marker: string) => {
  await mkdir(path.join(directory, 'services'), { recursive: true });
  await writeFile(path.join(directory, 'services/cli.js'), marker);
};

it('removes obsolete compiled modules before rebuilding', async () => {
  const { distDir, backupDir } = await makeWorkspace();
  const legacyCoordinatorPath = path.join(distDir, 'services/turn-coordinator.js');
  await mkdir(path.dirname(legacyCoordinatorPath), { recursive: true });
  await writeFile(legacyCoordinatorPath, 'legacy build artifact\n');

  const exitCode = await buildWithRollback({
    distDir,
    backupDir,
    steps: [async () => (await writeBuild(distDir, 'fresh'), 0)],
  });

  expect(exitCode).toBe(0);
  await expect(access(legacyCoordinatorPath)).rejects.toThrow();
});

it('keeps the previous build recoverable after a successful build', async () => {
  const { distDir, backupDir } = await makeWorkspace();
  await writeBuild(distDir, 'previous');

  const exitCode = await buildWithRollback({
    distDir,
    backupDir,
    steps: [async () => (await writeBuild(distDir, 'current'), 0)],
  });

  expect(exitCode).toBe(0);
  expect(await readFile(path.join(distDir, 'services/cli.js'), 'utf8')).toBe('current');
  expect(await readFile(path.join(backupDir, 'services/cli.js'), 'utf8')).toBe('previous');
});

it('restores the previous build when a build step fails', async () => {
  const { distDir, backupDir } = await makeWorkspace();
  await writeBuild(distDir, 'previous');

  const exitCode = await buildWithRollback({
    distDir,
    backupDir,
    steps: [async () => (await writeBuild(distDir, 'half-written'), 2)],
  });

  expect(exitCode).toBe(2);
  expect(await readFile(path.join(distDir, 'services/cli.js'), 'utf8')).toBe('previous');
  await expect(access(backupDir)).rejects.toThrow();
});

it('does not run later build steps once one fails', async () => {
  const { distDir, backupDir } = await makeWorkspace();
  const ranSteps: string[] = [];

  const exitCode = await buildWithRollback({
    distDir,
    backupDir,
    steps: [async () => (ranSteps.push('compile'), 1), async () => (ranSteps.push('post-build'), 0)],
  });

  expect(exitCode).toBe(1);
  expect(ranSteps).toEqual(['compile']);
});

it('reports failure without a restore when there was no previous build', async () => {
  const { distDir, backupDir } = await makeWorkspace();
  const messages: string[] = [];

  const exitCode = await buildWithRollback({
    distDir,
    backupDir,
    steps: [async () => 2],
    log: (message: string) => messages.push(message),
  });

  expect(exitCode).toBe(2);
  expect(messages).toEqual(['[build] build failed; there was no previous dist/ to restore']);
});

it('deletes rather than keeps the previous build when backup is disabled', async () => {
  const { distDir, backupDir } = await makeWorkspace();
  await writeBuild(distDir, 'previous');

  const exitCode = await buildWithRollback({
    distDir,
    backupDir,
    backup: false,
    steps: [async () => (await writeBuild(distDir, 'current'), 0)],
  });

  expect(exitCode).toBe(0);
  await expect(access(backupDir)).rejects.toThrow();
});

it('restorePreviousBuild() swaps the kept build back into place', async () => {
  const { distDir, backupDir } = await makeWorkspace();
  await writeBuild(distDir, 'current');
  await writeBuild(backupDir, 'previous');

  expect(await restorePreviousBuild({ distDir, backupDir })).toBe(true);
  expect(await readFile(path.join(distDir, 'services/cli.js'), 'utf8')).toBe('previous');
  await expect(access(backupDir)).rejects.toThrow();
});

it('restorePreviousBuild() reports when there is no kept build', async () => {
  const { distDir, backupDir } = await makeWorkspace();
  await writeBuild(distDir, 'current');

  expect(await restorePreviousBuild({ distDir, backupDir })).toBe(false);
  expect(await readFile(path.join(distDir, 'services/cli.js'), 'utf8')).toBe('current');
});
