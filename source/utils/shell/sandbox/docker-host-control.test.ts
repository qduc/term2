import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createDockerHostControl } from './docker-host-control.js';

const temporaryPaths: string[] = [];

afterEach(() => {
  for (const temporaryPath of temporaryPaths.splice(0)) {
    fs.rmSync(temporaryPath, { recursive: true, force: true });
  }
});

it('uses only the canonical Docker Desktop socket and an isolated client config', async () => {
  if (process.platform !== 'darwin') return;

  // macOS limits Unix socket paths to 104 bytes, so keep this fixture short.
  const home = fs.mkdtempSync(path.join(process.cwd(), '.t2dh-'));
  temporaryPaths.push(home);
  const socketDir = path.join(home, '.docker', 'run');
  fs.mkdirSync(socketDir, { recursive: true });
  const socketPath = path.join(socketDir, 'docker.sock');
  const statSync = vi.spyOn(fs, 'statSync').mockReturnValue({ isSocket: () => true } as fs.Stats);

  try {
    const control = createDockerHostControl(home);

    expect(control.socketPath).toBe(socketPath);
    expect(control.configDir).not.toContain(path.join(home, '.docker'));
    statSync.mockRestore();
    expect(fs.statSync(control.configDir).mode & 0o777).toBe(0o700);

    control.cleanup();
    expect(fs.existsSync(control.configDir)).toBe(false);
  } finally {
    statSync.mockRestore();
  }
});

it('rejects a missing Docker Desktop socket', () => {
  expect(() => createDockerHostControl(path.join(os.tmpdir(), 'missing-docker-home'))).toThrow(
    'Docker Desktop socket is unavailable',
  );
});
