import { it, expect } from 'vitest';
import * as path from 'path';
import { homedir } from 'os';
import { resolveWorkspacePath } from './utils.js';
import { SANDBOX_TEMP_DIR } from '../utils/shell/temp-dir.js';

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

it('resolveWorkspacePath: allows SANDBOX_TEMP_DIR even when outside workspace', () => {
  const workspace = '/Users/test/workspace';

  // Test the sandbox temp dir is allowed
  const resolvedSandboxTmp = resolveWorkspacePath(SANDBOX_TEMP_DIR + '/test-file.txt', workspace);
  expect(resolvedSandboxTmp).toBe(path.normalize(SANDBOX_TEMP_DIR + '/test-file.txt'));

  // Test that /tmp (broad) paths are NOT allowed — only the sandbox-specific temp dir
  expect(() => {
    resolveWorkspacePath('/tmp/test-file.txt', workspace);
  }).toThrow(/Operation outside workspace/);

  // Test that /private/tmp is also rejected
  expect(() => {
    resolveWorkspacePath('/private/tmp/sub/file.txt', workspace);
  }).toThrow(/Operation outside workspace/);

  // Test that /opt or other outside paths still throw
  expect(() => {
    resolveWorkspacePath('/opt/app.log', workspace);
  }).toThrow(/Operation outside workspace/);
});

it('resolveWorkspacePath: allows discovered skill directories outside workspace when enabled', () => {
  const workspace = '/tmp/workspace';
  const resolved = resolveWorkspacePath(path.join(homedir(), '.agents', 'skills', 'example', 'SKILL.md'), workspace, {
    allowDiscoveredSkillFolders: true,
  });

  expect(resolved).toBe(path.join(homedir(), '.agents', 'skills', 'example', 'SKILL.md'));
});

it('resolveWorkspacePath: still rejects non-skill outside paths when discovered-skill allowance is enabled', () => {
  const workspace = '/tmp/workspace';

  expect(() => {
    resolveWorkspacePath(path.join(homedir(), '.ssh', 'config'), workspace, {
      allowDiscoveredSkillFolders: true,
    });
  }).toThrow(/Operation outside workspace/);
});
