import { homedir } from 'node:os';
import { join } from 'node:path';

const APP_DIRECTORY_NAME = 'term2-nodejs';

export function resolveSettingsDirectory(
  options: {
    platform?: NodeJS.Platform;
    homeDir?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): string {
  const platform = options.platform ?? process.platform;
  const homeDir = options.homeDir ?? homedir();
  const env = options.env ?? process.env;

  if (platform === 'darwin') return join(homeDir, 'Library', 'Logs', APP_DIRECTORY_NAME);
  if (platform === 'win32') {
    return join(env.LOCALAPPDATA ?? join(homeDir, 'AppData', 'Local'), APP_DIRECTORY_NAME, 'Log');
  }
  return join(env.XDG_STATE_HOME ?? join(homeDir, '.local', 'state'), APP_DIRECTORY_NAME);
}
