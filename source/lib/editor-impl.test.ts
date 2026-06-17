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

it('createFile rejects path outside workspace using parent directory traversal', async () => {
  const logger = createMockLogger();
  const settings = createMockSettings({ 'tools.logFileOperations': false });
  const editor = createEditorImpl({ loggingService: logger, settingsService: settings });

  const result = await editor.createFile({
    type: 'create_file',
    path: '../../../etc/passwd',
    diff: '*** Begin Patch\n*** Add File: test\n+test content\n*** End Patch',
  });

  expect(result.status).toBe('failed');
  expect(result.output?.includes('Operation outside workspace')).toBe(true);
});

it('updateFile rejects absolute path outside workspace', async () => {
  const logger = createMockLogger();
  const settings = createMockSettings({ 'tools.logFileOperations': false });
  const editor = createEditorImpl({ loggingService: logger, settingsService: settings });

  const result = await editor.updateFile({
    type: 'update_file',
    path: '/etc/passwd',
    diff: '*** Begin Patch\n*** Update File: /etc/passwd\n-root\n+hacked\n*** End Patch',
  });

  expect(result.status).toBe('failed');
  expect(result.output?.includes('Operation outside workspace') || result.output?.includes('Cannot update')).toBe(true);
});

it('deleteFile rejects path outside workspace', async () => {
  const logger = createMockLogger();
  const settings = createMockSettings({ 'tools.logFileOperations': false });
  const editor = createEditorImpl({ loggingService: logger, settingsService: settings });

  const result = await editor.deleteFile({
    type: 'delete_file',
    path: '../../../tmp/somefile',
  });

  expect(result.status).toBe('failed');
  expect(result.output?.includes('Operation outside workspace')).toBe(true);
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
