import { expect, it } from 'vitest';
import { join } from 'node:path';
import { resolveSettingsDirectory } from './settings-path.js';

it('resolves the macOS settings directory', () => {
  expect(resolveSettingsDirectory({ platform: 'darwin', homeDir: '/home/test', env: {} })).toBe(
    join('/home/test', 'Library', 'Logs', 'term2-nodejs'),
  );
});

it('resolves the Linux settings directory with and without an XDG state override', () => {
  expect(resolveSettingsDirectory({ platform: 'linux', homeDir: '/home/test', env: {} })).toBe(
    join('/home/test', '.local', 'state', 'term2-nodejs'),
  );
  expect(
    resolveSettingsDirectory({
      platform: 'linux',
      homeDir: '/home/test',
      env: { XDG_STATE_HOME: '/isolated/state' },
    }),
  ).toBe(join('/isolated/state', 'term2-nodejs'));
});

it('resolves the Windows settings directory from local app data', () => {
  const localAppData = join('C:', 'Users', 'test', 'AppData', 'Local');
  expect(
    resolveSettingsDirectory({
      platform: 'win32',
      homeDir: join('C:', 'Users', 'test'),
      env: { LOCALAPPDATA: localAppData },
    }),
  ).toBe(join(localAppData, 'term2-nodejs', 'Log'));
});
