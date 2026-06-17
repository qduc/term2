import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { scanWorkspaceEntries } from './file-service.js';

it('scanWorkspaceEntries prioritizes breadth over depth when capped', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'term2-file-service-'));

  try {
    await fs.mkdir(path.join(root, 'a', 'nested'), { recursive: true });
    await fs.writeFile(path.join(root, 'a', 'nested', 'deep.txt'), 'deep');
    await fs.writeFile(path.join(root, 'b.txt'), 'flat');

    const result = await scanWorkspaceEntries(root, {
      maxTotalEntries: 2,
      maxDepth: 10,
    });

    expect(
      result.entries.map((entry) => entry.path),
      'The scan should keep shallow entries before descending into nested directories',
    ).toEqual(['a', 'b.txt']);
    expect(result.truncated).toBe(true);
    expect(result.truncatedByTotalLimit).toBe(true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

it('scanWorkspaceEntries lists every entry in a directory, with no per-directory cap', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'term2-file-service-'));

  try {
    await fs.writeFile(path.join(root, 'a.txt'), '');
    await fs.writeFile(path.join(root, 'b.txt'), '');
    await fs.writeFile(path.join(root, 'c.txt'), '');

    const result = await scanWorkspaceEntries(root, {
      maxTotalEntries: 5_000,
      maxDepth: 10,
    });

    expect(result.entries.map((entry) => entry.path).sort()).toEqual(['a.txt', 'b.txt', 'c.txt']);
    expect(result.truncated).toBe(false);
    expect(result.truncatedByTotalLimit).toBe(false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

it('scanWorkspaceEntries lists symlinks without traversing them', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'term2-file-service-'));

  try {
    await fs.mkdir(path.join(root, 'real-dir'));
    await fs.writeFile(path.join(root, 'real-dir', 'inner.txt'), '');
    await fs.writeFile(path.join(root, 'target.txt'), '');
    await fs.symlink(path.join(root, 'target.txt'), path.join(root, 'file-link'));
    await fs.symlink(path.join(root, 'real-dir'), path.join(root, 'dir-link'));

    const result = await scanWorkspaceEntries(root, { maxDepth: 10 });
    const byPath = new Map(result.entries.map((entry) => [entry.path, entry.type]));

    expect(byPath.get('file-link'), 'a symlink to a file is listed as a file').toBe('file');
    expect(byPath.get('dir-link'), 'a symlink to a directory is listed as a directory').toBe('directory');
    expect(result.entries.some((entry) => entry.path === 'dir-link/inner.txt')).toBe(false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
