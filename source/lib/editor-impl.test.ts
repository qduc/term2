import test from 'ava';
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

test('createFile rejects path outside workspace using parent directory traversal', async (t) => {
  const logger = createMockLogger();
  const settings = createMockSettings({ 'tools.logFileOperations': false });
  const editor = createEditorImpl({ loggingService: logger, settingsService: settings });

  const result = await editor.createFile({
    type: 'create_file',
    path: '../../../etc/passwd',
    diff: '*** Begin Patch\n*** Add File: test\n+test content\n*** End Patch',
  });

  t.is(result.status, 'failed');
  t.true(result.output?.includes('Operation outside workspace'));
});

test('updateFile rejects absolute path outside workspace', async (t) => {
  const logger = createMockLogger();
  const settings = createMockSettings({ 'tools.logFileOperations': false });
  const editor = createEditorImpl({ loggingService: logger, settingsService: settings });

  const result = await editor.updateFile({
    type: 'update_file',
    path: '/etc/passwd',
    diff: '*** Begin Patch\n*** Update File: /etc/passwd\n-root\n+hacked\n*** End Patch',
  });

  t.is(result.status, 'failed');
  t.true(result.output?.includes('Operation outside workspace') || result.output?.includes('Cannot update'));
});

test('deleteFile rejects path outside workspace', async (t) => {
  const logger = createMockLogger();
  const settings = createMockSettings({ 'tools.logFileOperations': false });
  const editor = createEditorImpl({ loggingService: logger, settingsService: settings });

  const result = await editor.deleteFile({
    type: 'delete_file',
    path: '../../../tmp/somefile',
  });

  t.is(result.status, 'failed');
  t.true(result.output?.includes('Operation outside workspace'));
});

// ========== createFile tests ==========

test('createFile creates a new file with valid diff', async (t) => {
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

    t.is(result.status, 'completed');
    t.true(result.output?.includes('Created'));

    const content = await readFile(testFile, 'utf8');
    t.is(content, 'hello world\n');
  });
});

test('createFile returns failed status for invalid diff', async (t) => {
  const logger = createMockLogger();
  const settings = createMockSettings({ 'tools.logFileOperations': false });
  const editor = createEditorImpl({ loggingService: logger, settingsService: settings });

  const result = await editor.createFile({
    type: 'create_file',
    path: 'test-file.txt',
    diff: 'this is not a valid diff format',
  });

  t.is(result.status, 'failed');
  t.true(result.output?.includes('Invalid patch'));
});

// ========== updateFile tests ==========

test('updateFile updates existing file with valid diff', async (t) => {
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

    t.is(result.status, 'completed');
    t.true(result.output?.includes('Updated'));

    const content = await readFile(testFile, 'utf8');
    t.true(content.includes('modified line2'));
  });
});

test('updateFile returns failed status for missing file', async (t) => {
  const logger = createMockLogger();
  const settings = createMockSettings({ 'tools.logFileOperations': true });
  const editor = createEditorImpl({ loggingService: logger, settingsService: settings });

  const result = await editor.updateFile({
    type: 'update_file',
    path: 'nonexistent-file-12345.txt',
    diff: '*** Begin Patch\n*** Update File: nonexistent\n-old\n+new\n*** End Patch',
  });

  t.is(result.status, 'failed');
  t.true(result.output?.includes('Cannot update missing file'));
});

test('updateFile returns failed status for invalid diff', async (t) => {
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

    t.is(result.status, 'failed');
    t.true(result.output?.includes('Invalid patch'));
  });
});

// ========== deleteFile tests ==========

test('deleteFile deletes existing file', async (t) => {
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

    t.is(result.status, 'completed');
    t.true(result.output?.includes('Deleted'));

    // Verify file is gone
    await t.throwsAsync(readFile(testFile, 'utf8'), { code: 'ENOENT' });
  });
});

test('deleteFile succeeds even when file does not exist (force: true)', async (t) => {
  const logger = createMockLogger();
  const settings = createMockSettings({ 'tools.logFileOperations': false });
  const editor = createEditorImpl({ loggingService: logger, settingsService: settings });

  const result = await editor.deleteFile({
    type: 'delete_file',
    path: 'nonexistent-file-to-delete-67890.txt',
  });

  // rm with force:true doesn't fail for missing files
  t.is(result.status, 'completed');
});
