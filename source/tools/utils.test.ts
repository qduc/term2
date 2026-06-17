import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { homedir } from 'os';
import { resolveWorkspacePath } from './utils.js';

it('resolveWorkspacePath: expands ~ to home directory', () => {
  const home = homedir();
  const workspace = '/Users/test/workspace';

  // Test ~/ expansion
  const resolved = resolveWorkspacePath('~/documents/file.txt', workspace, { allowOutsideWorkspace: true });
  expect(resolved).toBe(path.join(home, 'documents', 'file.txt'));

  // Test ~ expansion
  const resolvedHome = resolveWorkspacePath('~', workspace, { allowOutsideWorkspace: true });
  expect(resolvedHome).toBe(home);
});

it('resolveWorkspacePath: throws if ~ expanded path is outside workspace and not allowed', () => {
  const workspace = '/tmp/workspace';

  expect(() => {
    resolveWorkspacePath('~/somefile', workspace, { allowOutsideWorkspace: false });
  }).toThrow(/Operation outside workspace/);
});

it('resolveWorkspacePath: handles regular relative paths', () => {
  const workspace = '/tmp/workspace';
  const resolved = resolveWorkspacePath('src/main.ts', workspace);
  expect(resolved).toBe(path.join(workspace, 'src/main.ts'));
});

it('resolveWorkspacePath: allows paths under /tmp or /private/tmp even when outside workspace', () => {
  const workspace = '/Users/test/workspace';

  // Test /tmp path
  const resolvedTmp = resolveWorkspacePath('/tmp/test-file.txt', workspace);
  expect(resolvedTmp).toBe(path.normalize('/tmp/test-file.txt'));

  // Test /private/tmp path
  const resolvedPrivateTmp = resolveWorkspacePath('/private/tmp/sub/file.txt', workspace);
  expect(resolvedPrivateTmp).toBe(path.normalize('/private/tmp/sub/file.txt'));

  // Test that /opt or other outside paths still throw

  expect(() => {
    resolveWorkspacePath('/opt/app.log', workspace);
  }).toThrow(/Operation outside workspace/);
});
