import { it, expect } from 'vitest';
import path from 'path';
import os from 'node:os';
import { writeFile, readFile, rm, mkdtemp } from 'fs/promises';
import { createEditorImpl } from './editor-impl.js';
import type { ILoggingService, ISettingsService } from '../services/service-interfaces.js';

// Helper to create a temp dir
async function withTempDir(run: (dir: string) => Promise<void>) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'term2-editor-test-'));
  try {
    await run(tempDir);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

// Helper to create a temp dir outside /tmp so tests can exercise parent-directory
// traversal without the /tmp safety exception silently letting writes through.
async function withNonTmpTempDir(run: (dir: string) => Promise<void>) {
  const tempDir = await mkdtemp(path.join(os.homedir(), '.term2-editor-test-'));
  try {
    await run(tempDir);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function createMockExecutionContext(cwd: string) {
  return {
    getCwd: () => cwd,
    isRemote: () => false,
    getSSHService: () => undefined,
  };
}

// Helper to create a mock logging service
function createMockLogger(): ILoggingService {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    security: () => {},
    setCorrelationId: () => {},
    clearCorrelationId: () => {},
    getCorrelationId: () => undefined,
  };
}

// Helper to create a mock settings service
function createMockSettings(values: Record<string, any> = {}): ISettingsService {
  return {
    get: <T>(key: string) => values[key] as T,
    set: () => {},
  };
}

// ========== resolveWorkspacePath tests (via editor operations) ==========

it('createFile writes outside workspace when the SDK has approved the operation', async () => {
  // The editor's createFile trusts the SDK's `needsApproval` gate. With a
  // workspace rooted in a non-/tmp temp dir, a `../` path resolves to a
  // sibling file the test owns and can safely create. The boundary check
  // itself is asserted at the agent-factory level in `agent-factory.test.ts`.
  await withNonTmpTempDir(async (workspaceDir) => {
    const logger = createMockLogger();
    const settings = createMockSettings({ 'tools.logFileOperations': false });
    const editor = createEditorImpl({
      loggingService: logger,
      settingsService: settings,
      executionContext: createMockExecutionContext(workspaceDir) as any,
    });

    const outsidePath = path.join(path.dirname(workspaceDir), 'outside-approved.txt');
    await rm(outsidePath, { force: true });

    const result = await editor.createFile({
      type: 'create_file',
      path: '../outside-approved.txt',
      diff: '@@ -0,0 +1 @@\n+approved',
    });

    expect(result.status).toBe('completed');
    expect(result.output?.includes('Operation outside workspace')).toBe(false);
    expect((await readFile(outsidePath, 'utf8')).trim()).toBe('approved');

    await rm(outsidePath, { force: true });
  });
});

it('updateFile updates outside workspace when the SDK has approved the operation', async () => {
  await withNonTmpTempDir(async (workspaceDir) => {
    const logger = createMockLogger();
    const settings = createMockSettings({ 'tools.logFileOperations': false });
    const editor = createEditorImpl({
      loggingService: logger,
      settingsService: settings,
      executionContext: createMockExecutionContext(workspaceDir) as any,
    });

    const outsidePath = path.join(path.dirname(workspaceDir), 'outside-approved.txt');
    await writeFile(outsidePath, 'old content\n');

    const result = await editor.updateFile({
      type: 'update_file',
      path: '../outside-approved.txt',
      diff: '@@ -1 +1 @@\n-old content\n+new content',
    });

    expect(result.status).toBe('completed');
    expect(result.output?.includes('Operation outside workspace')).toBe(false);
    expect(await readFile(outsidePath, 'utf8')).toBe('new content\n');

    await rm(outsidePath, { force: true });
  });
});

it('deleteFile deletes outside workspace when the SDK has approved the operation', async () => {
  await withNonTmpTempDir(async (workspaceDir) => {
    const logger = createMockLogger();
    const settings = createMockSettings({ 'tools.logFileOperations': false });
    const editor = createEditorImpl({
      loggingService: logger,
      settingsService: settings,
      executionContext: createMockExecutionContext(workspaceDir) as any,
    });

    const outsidePath = path.join(path.dirname(workspaceDir), 'outside-approved.txt');
    await writeFile(outsidePath, 'doomed\n');

    const result = await editor.deleteFile({
      type: 'delete_file',
      path: '../outside-approved.txt',
    });

    expect(result.status).toBe('completed');
    expect(result.output?.includes('Operation outside workspace')).toBe(false);
    await expect(readFile(outsidePath, 'utf8')).rejects.toThrow();
  });
});

// ========== createFile tests ==========

it('createFile creates a new file with valid diff', async () => {
  await withTempDir(async (dir) => {
    const logger = createMockLogger();
    const settings = createMockSettings({ 'tools.logFileOperations': true });
    const editor = createEditorImpl({
      loggingService: logger,
      settingsService: settings,
      executionContext: createMockExecutionContext(dir) as any,
    });

    const testFile = path.join(dir, 'new-file.txt');

    const result = await editor.createFile({
      type: 'create_file',
      path: 'new-file.txt',
      diff: '@@ -0,0 +1 @@\n+hello world',
    });

    expect(result.status).toBe('completed');
    expect(result.output?.includes('Created')).toBe(true);

    const content = await readFile(testFile, 'utf8');
    expect(content).toBe('hello world\n');
  });
});

it('createFile returns failed status for invalid diff', async () => {
  const logger = createMockLogger();
  const settings = createMockSettings({ 'tools.logFileOperations': false });
  const editor = createEditorImpl({ loggingService: logger, settingsService: settings });

  const result = await editor.createFile({
    type: 'create_file',
    path: 'test-file.txt',
    diff: 'this is not a valid diff format',
  });

  expect(result.status).toBe('failed');
  expect(result.output?.includes('Invalid patch')).toBe(true);
});

// ========== updateFile tests ==========

it('updateFile updates existing file with valid diff', async () => {
  await withTempDir(async (dir) => {
    const logger = createMockLogger();
    const settings = createMockSettings({ 'tools.logFileOperations': true });
    const editor = createEditorImpl({
      loggingService: logger,
      settingsService: settings,
      executionContext: createMockExecutionContext(dir) as any,
    });

    const testFile = path.join(dir, 'existing.txt');

    await writeFile(testFile, 'line1\nline2\nline3\n', 'utf8');

    const result = await editor.updateFile({
      type: 'update_file',
      path: 'existing.txt',
      diff: '@@ -1,3 +1,3 @@\n line1\n-line2\n+modified line2\n line3',
    });

    expect(result.status).toBe('completed');
    expect(result.output?.includes('Updated')).toBe(true);

    const content = await readFile(testFile, 'utf8');
    expect(content.includes('modified line2')).toBe(true);
  });
});

it('updateFile returns failed status for missing file', async () => {
  const logger = createMockLogger();
  const settings = createMockSettings({ 'tools.logFileOperations': true });
  const editor = createEditorImpl({ loggingService: logger, settingsService: settings });

  const result = await editor.updateFile({
    type: 'update_file',
    path: 'nonexistent-file-12345.txt',
    diff: '*** Begin Patch\n*** Update File: nonexistent\n-old\n+new\n*** End Patch',
  });

  expect(result.status).toBe('failed');
  expect(result.output?.includes('Cannot update missing file')).toBe(true);
});

it('updateFile returns failed status for invalid diff', async () => {
  await withTempDir(async (dir) => {
    const logger = createMockLogger();
    const settings = createMockSettings({ 'tools.logFileOperations': false });
    const editor = createEditorImpl({
      loggingService: logger,
      settingsService: settings,
      executionContext: createMockExecutionContext(dir) as any,
    });

    const testFile = path.join(dir, 'existing.txt');

    await writeFile(testFile, 'original content\n', 'utf8');

    const result = await editor.updateFile({
      type: 'update_file',
      path: 'existing.txt',
      diff: 'not a valid diff',
    });

    expect(result.status).toBe('failed');
    expect(result.output?.includes('Invalid patch')).toBe(true);
  });
});

// ========== deleteFile tests ==========

it('deleteFile deletes existing file', async () => {
  await withTempDir(async (dir) => {
    const logger = createMockLogger();
    const settings = createMockSettings({ 'tools.logFileOperations': true });
    const editor = createEditorImpl({
      loggingService: logger,
      settingsService: settings,
      executionContext: createMockExecutionContext(dir) as any,
    });

    const testFile = path.join(dir, 'to-delete.txt');

    await writeFile(testFile, 'delete me\n', 'utf8');

    const result = await editor.deleteFile({
      type: 'delete_file',
      path: 'to-delete.txt',
    });

    expect(result.status).toBe('completed');
    expect(result.output?.includes('Deleted')).toBe(true);

    // Verify file is gone
    await expect(readFile(testFile, 'utf8')).rejects.toHaveProperty('code', 'ENOENT');
  });
});

it('deleteFile succeeds even when file does not exist (force: true)', async () => {
  const logger = createMockLogger();
  const settings = createMockSettings({ 'tools.logFileOperations': false });
  const editor = createEditorImpl({ loggingService: logger, settingsService: settings });

  const result = await editor.deleteFile({
    type: 'delete_file',
    path: 'nonexistent-file-to-delete-67890.txt',
  });

  // rm with force:true doesn't fail for missing files
  expect(result.status).toBe('completed');
});
