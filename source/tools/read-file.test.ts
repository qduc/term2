import test from 'ava';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { createReadFileToolDefinition } from './read-file.js';

const readFileToolDefinition = createReadFileToolDefinition();
const readFileToolDefinitionAllowOutside = createReadFileToolDefinition({
  allowOutsideWorkspace: true,
});

// Helper to create a temp dir and change cwd to it
async function withTempDir(run: (dir: string) => Promise<void>) {
  const originalCwd = process.cwd;
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'term2-test-'));
  const workspaceDir = path.join(rootDir, 'workspace');
  await fs.mkdir(workspaceDir, { recursive: true });

  // Mock process.cwd (treat workspaceDir as the "workspace")
  process.cwd = () => workspaceDir;

  try {
    await run(workspaceDir);
  } finally {
    process.cwd = originalCwd;
    await fs.rm(rootDir, { recursive: true, force: true });
  }
}

test.serial('needsApproval: returns false for read-only operation', async (t) => {
  await withTempDir(async () => {
    const result = await readFileToolDefinition.needsApproval({
      path: 'test.txt',
      start_line: null,
      end_line: null,
    });
    t.false(result);
  });
});

test.serial('execute: successfully reads a file', async (t) => {
  await withTempDir(async (dir) => {
    const filePath = 'test.txt';
    const content = 'Hello\nWorld\nFrom\nFile';
    await fs.writeFile(path.join(dir, filePath), content);

    const result = await readFileToolDefinition.execute({
      path: filePath,
      start_line: null,
      end_line: null,
    });

    // Result should include header and content
    t.true(result.includes('File: test.txt'));
    t.true(result.includes('4 lines'));
    t.true(result.includes('Hello'));
    t.true(result.includes('World'));
    t.true(result.includes('From'));
    t.true(result.includes('File'));
  });
});

test.serial('execute: reads file with line range', async (t) => {
  await withTempDir(async (dir) => {
    const filePath = 'test.txt';
    const content = 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5';
    await fs.writeFile(path.join(dir, filePath), content);

    const result = await readFileToolDefinition.execute({
      path: filePath,
      start_line: 2,
      end_line: 4,
    });

    // Should only include lines 2-4
    t.true(result.includes('[lines 2-4]'));
    t.false(result.includes('Line 1'));
    t.true(result.includes('Line 2'));
    t.true(result.includes('Line 3'));
    t.true(result.includes('Line 4'));
    t.false(result.includes('Line 5'));
  });
});

test.serial('execute: reads file from start_line to end', async (t) => {
  await withTempDir(async (dir) => {
    const filePath = 'test.txt';
    const content = 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5';
    await fs.writeFile(path.join(dir, filePath), content);

    const result = await readFileToolDefinition.execute({
      path: filePath,
      start_line: 3,
      end_line: null,
    });

    // Should include lines 3-5
    t.true(result.includes('[lines 3-5]'));
    t.false(result.includes('Line 1'));
    t.false(result.includes('Line 2'));
    t.true(result.includes('Line 3'));
    t.true(result.includes('Line 4'));
    t.true(result.includes('Line 5'));
  });
});

test.serial('execute: rejects path outside workspace', async (t) => {
  await withTempDir(async () => {
    const result = await readFileToolDefinition.execute({
      path: '../outside.txt',
      start_line: null,
      end_line: null,
    });

    t.true(result.includes('Error'));
    t.true(result.includes('outside workspace'));
  });
});

test.serial('execute: in allowOutsideWorkspace mode, can read outside workspace', async (t) => {
  await withTempDir(async (dir) => {
    const outsidePath = path.join(dir, '..', 'outside.txt');
    await fs.writeFile(outsidePath, 'outside\ncontent');

    const result = await readFileToolDefinitionAllowOutside.execute({
      path: '../outside.txt',
      start_line: null,
      end_line: null,
    });

    t.true(result.includes('outside'));
    t.true(result.includes('content'));
    t.false(result.includes('outside workspace'));
  });
});

test.serial('execute: handles file not found', async (t) => {
  await withTempDir(async () => {
    const result = await readFileToolDefinition.execute({
      path: 'nonexistent.txt',
      start_line: null,
      end_line: null,
    });

    t.true(result.includes('Error'));
    t.true(result.includes('ENOENT') || result.includes('not found'));
  });
});

test.serial('execute: handles empty file', async (t) => {
  await withTempDir(async (dir) => {
    const filePath = 'empty.txt';
    await fs.writeFile(path.join(dir, filePath), '');

    const result = await readFileToolDefinition.execute({
      path: filePath,
      start_line: null,
      end_line: null,
    });

    t.is(result.trim(), '');
  });
});

test.serial('execute: handles line range beyond file length', async (t) => {
  await withTempDir(async (dir) => {
    const filePath = 'short.txt';
    const content = 'Line 1\nLine 2';
    await fs.writeFile(path.join(dir, filePath), content);

    const result = await readFileToolDefinition.execute({
      path: filePath,
      start_line: 1,
      end_line: 10,
    });

    // Should only include available lines
    t.true(result.includes('Line 1'));
    t.true(result.includes('Line 2'));
    t.true(result.includes('2 lines'));
  });
});
