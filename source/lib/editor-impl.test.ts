import test from 'ava';
import path from 'path';
import { mkdir, writeFile, readFile, rm } from 'fs/promises';
import { createEditorImpl } from './editor-impl.js';
import type { ILoggingService, ISettingsService } from '../services/service-interfaces.js';

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
  const logger = createMockLogger();
  const settings = createMockSettings({ 'tools.logFileOperations': true });
  const editor = createEditorImpl({ loggingService: logger, settingsService: settings });

  const testDir = path.join(process.cwd(), 'test-tmp-editor');
  const testFile = path.join(testDir, 'new-file.txt');

  try {
    await mkdir(testDir, { recursive: true });

    const result = await editor.createFile({
      type: 'create_file',
      path: path.relative(process.cwd(), testFile),
      diff: '@@ -0,0 +1 @@\n+hello world',
    });

    t.is(result.status, 'completed');
    t.true(result.output?.includes('Created'));

    const content = await readFile(testFile, 'utf8');
    t.is(content, 'hello world\n');
  } finally {
    await rm(testDir, { recursive: true, force: true });
  }
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
  const logger = createMockLogger();
  const settings = createMockSettings({ 'tools.logFileOperations': true });
  const editor = createEditorImpl({ loggingService: logger, settingsService: settings });

  const testDir = path.join(process.cwd(), 'test-tmp-editor-update');
  const testFile = path.join(testDir, 'existing.txt');

  try {
    await mkdir(testDir, { recursive: true });
    await writeFile(testFile, 'line1\nline2\nline3\n', 'utf8');

    const relativePath = path.relative(process.cwd(), testFile);
    const result = await editor.updateFile({
      type: 'update_file',
      path: relativePath,
      diff: '@@ -1,3 +1,3 @@\n line1\n-line2\n+modified line2\n line3',
    });

    t.is(result.status, 'completed');
    t.true(result.output?.includes('Updated'));

    const content = await readFile(testFile, 'utf8');
    t.true(content.includes('modified line2'));
  } finally {
    await rm(testDir, { recursive: true, force: true });
  }
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
  const logger = createMockLogger();
  const settings = createMockSettings({ 'tools.logFileOperations': false });
  const editor = createEditorImpl({ loggingService: logger, settingsService: settings });

  const testDir = path.join(process.cwd(), 'test-tmp-editor-invalid');
  const testFile = path.join(testDir, 'existing.txt');

  try {
    await mkdir(testDir, { recursive: true });
    await writeFile(testFile, 'original content\n', 'utf8');

    const result = await editor.updateFile({
      type: 'update_file',
      path: path.relative(process.cwd(), testFile),
      diff: 'not a valid diff',
    });

    t.is(result.status, 'failed');
    t.true(result.output?.includes('Invalid patch'));
  } finally {
    await rm(testDir, { recursive: true, force: true });
  }
});

// ========== deleteFile tests ==========

test('deleteFile deletes existing file', async (t) => {
  const logger = createMockLogger();
  const settings = createMockSettings({ 'tools.logFileOperations': true });
  const editor = createEditorImpl({ loggingService: logger, settingsService: settings });

  const testDir = path.join(process.cwd(), 'test-tmp-editor-delete');
  const testFile = path.join(testDir, 'to-delete.txt');

  try {
    await mkdir(testDir, { recursive: true });
    await writeFile(testFile, 'delete me\n', 'utf8');

    const result = await editor.deleteFile({
      type: 'delete_file',
      path: path.relative(process.cwd(), testFile),
    });

    t.is(result.status, 'completed');
    t.true(result.output?.includes('Deleted'));

    // Verify file is gone
    await t.throwsAsync(readFile(testFile, 'utf8'), { code: 'ENOENT' });
  } finally {
    await rm(testDir, { recursive: true, force: true });
  }
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
