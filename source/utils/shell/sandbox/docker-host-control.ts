import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SANDBOX_TEMP_DIR } from '../temp-dir.js';

export interface DockerHostControl {
  socketPath: string;
  configDir: string;
  cleanup(): void;
}

/**
 * Docker Desktop's Unix socket controls the host daemon, so this deliberately
 * recognizes only its canonical per-user macOS endpoint.
 */
export function createDockerHostControl(home = os.homedir()): DockerHostControl {
  if (process.platform !== 'darwin') {
    throw new Error('Docker host control is currently supported only on macOS.');
  }

  const socketPath = path.join(home, '.docker', 'run', 'docker.sock');
  let socketStat: fs.Stats;
  try {
    socketStat = fs.statSync(socketPath);
  } catch {
    throw new Error(`Docker Desktop socket is unavailable at ${socketPath}.`);
  }
  if (!socketStat.isSocket()) {
    throw new Error(`Docker Desktop endpoint is not a Unix socket: ${socketPath}.`);
  }

  const configDir = fs.mkdtempSync(path.join(SANDBOX_TEMP_DIR, 'docker-config-'));
  fs.chmodSync(configDir, 0o700);

  return {
    socketPath,
    configDir,
    cleanup: () => fs.rmSync(configDir, { recursive: true, force: true }),
  };
}
