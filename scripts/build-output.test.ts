import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

it('removes obsolete compiled modules before rebuilding', async () => {
  const outputDirectory = await mkdtemp(path.join(os.tmpdir(), 'term2-build-output-'));
  temporaryDirectories.push(outputDirectory);
  const legacyCoordinatorPath = path.join(outputDirectory, 'services/turn-coordinator.js');
  await mkdir(path.dirname(legacyCoordinatorPath), { recursive: true });
  await writeFile(legacyCoordinatorPath, 'legacy build artifact\n', { flag: 'w' });

  await execFileAsync('node', ['scripts/clean-build-output.mjs', outputDirectory]);

  await expect(access(legacyCoordinatorPath)).rejects.toThrow();
});
