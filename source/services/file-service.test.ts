import test from 'ava';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { scanWorkspaceEntries } from './file-service.js';

test('scanWorkspaceEntries prioritizes breadth over depth when capped', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'term2-file-service-'));

  try {
    await fs.mkdir(path.join(root, 'a', 'nested'), { recursive: true });
    await fs.writeFile(path.join(root, 'a', 'nested', 'deep.txt'), 'deep');
    await fs.writeFile(path.join(root, 'b.txt'), 'flat');

    const result = await scanWorkspaceEntries(root, {
      maxTotalEntries: 2,
      maxDepth: 10,
    });

    t.deepEqual(
      result.entries.map((entry) => entry.path),
      ['a', 'b.txt'],
      'The scan should keep shallow entries before descending into nested directories',
    );
    t.true(result.truncated);
    t.true(result.truncatedByTotalLimit);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('scanWorkspaceEntries lists every entry in a directory, with no per-directory cap', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'term2-file-service-'));

  try {
    await fs.writeFile(path.join(root, 'a.txt'), '');
    await fs.writeFile(path.join(root, 'b.txt'), '');
    await fs.writeFile(path.join(root, 'c.txt'), '');

    const result = await scanWorkspaceEntries(root, {
      maxTotalEntries: 5_000,
      maxDepth: 10,
    });

    t.deepEqual(result.entries.map((entry) => entry.path).sort(), ['a.txt', 'b.txt', 'c.txt']);
    t.false(result.truncated);
    t.false(result.truncatedByTotalLimit);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('scanWorkspaceEntries lists symlinks without traversing them', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'term2-file-service-'));

  try {
    await fs.mkdir(path.join(root, 'real-dir'));
    await fs.writeFile(path.join(root, 'real-dir', 'inner.txt'), '');
    await fs.writeFile(path.join(root, 'target.txt'), '');
    await fs.symlink(path.join(root, 'target.txt'), path.join(root, 'file-link'));
    await fs.symlink(path.join(root, 'real-dir'), path.join(root, 'dir-link'));

    const result = await scanWorkspaceEntries(root, { maxDepth: 10 });
    const byPath = new Map(result.entries.map((entry) => [entry.path, entry.type]));

    t.is(byPath.get('file-link'), 'file', 'a symlink to a file is listed as a file');
    t.is(byPath.get('dir-link'), 'directory', 'a symlink to a directory is listed as a directory');
    t.false(
      result.entries.some((entry) => entry.path === 'dir-link/inner.txt'),
      'symlinked directories must not be traversed',
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
