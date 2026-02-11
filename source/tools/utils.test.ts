import test from 'ava';
import * as path from 'path';
import { homedir } from 'os';
import { resolveWorkspacePath } from './utils.js';

test('resolveWorkspacePath: expands ~ to home directory', (t) => {
  const home = homedir();
  const workspace = '/Users/test/workspace';

  // Test ~/ expansion
  const resolved = resolveWorkspacePath('~/documents/file.txt', workspace, { allowOutsideWorkspace: true });
  t.is(resolved, path.join(home, 'documents', 'file.txt'));

  // Test ~ expansion
  const resolvedHome = resolveWorkspacePath('~', workspace, { allowOutsideWorkspace: true });
  t.is(resolvedHome, home);
});

test('resolveWorkspacePath: throws if ~ expanded path is outside workspace and not allowed', (t) => {
  const workspace = '/tmp/workspace';

  t.throws(
    () => {
      resolveWorkspacePath('~/somefile', workspace, { allowOutsideWorkspace: false });
    },
    { message: /Operation outside workspace/ },
  );
});

test('resolveWorkspacePath: handles regular relative paths', (t) => {
  const workspace = '/tmp/workspace';
  const resolved = resolveWorkspacePath('src/main.ts', workspace);
  t.is(resolved, path.join(workspace, 'src/main.ts'));
});
