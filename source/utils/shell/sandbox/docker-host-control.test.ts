import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createDockerHostControl, requestsDockerHostControl } from './docker-host-control.js';

const temporaryPaths: string[] = [];

afterEach(() => {
  for (const temporaryPath of temporaryPaths.splice(0)) {
    fs.rmSync(temporaryPath, { recursive: true, force: true });
  }
});

it('recognizes direct Docker CLI invocations but not Docker text in other commands', () => {
  expect(requestsDockerHostControl('docker ps')).toBe(true);
  expect(requestsDockerHostControl('/usr/local/bin/docker compose up')).toBe(true);
  expect(requestsDockerHostControl('cd project && docker ps')).toBe(true);
  expect(requestsDockerHostControl('echo docker ps')).toBe(false);
});

it('recognizes Docker in every command position a shell can put it in', () => {
  // Regression: a subshell prefix left the invocation undetected, so the command
  // ran sandboxed and Docker fell back to the default /var/run/docker.sock context.
  expect(requestsDockerHostControl("(docker ps --format 'table {{.Names}}' 2>&1 || true) && echo done")).toBe(true);
  expect(requestsDockerHostControl('{ docker ps; }')).toBe(true);
  expect(requestsDockerHostControl('echo hi\ndocker ps')).toBe(true);
  expect(requestsDockerHostControl('cat ids.txt | docker rm')).toBe(true);
  expect(requestsDockerHostControl('docker-compose up -d')).toBe(true);
});

it('sees through command wrappers and environment assignments', () => {
  expect(requestsDockerHostControl('sudo docker ps')).toBe(true);
  expect(requestsDockerHostControl('env docker version')).toBe(true);
  expect(requestsDockerHostControl('DOCKER_BUILDKIT=1 docker build .')).toBe(true);
  expect(requestsDockerHostControl('timeout 60 docker ps')).toBe(true);
  expect(requestsDockerHostControl('xargs docker rm')).toBe(true);
});

it('ignores Docker inside quoted arguments, where shell punctuation is not an operator', () => {
  // A false positive here refuses the command outright, so quoting must be respected.
  expect(requestsDockerHostControl('git commit -m "fix(docker): update"')).toBe(false);
  expect(requestsDockerHostControl("rg 'podman|docker' source")).toBe(false);
  expect(requestsDockerHostControl("sed -e 's/(docker)/x/' file")).toBe(false);
});

it('ignores Docker mentioned as an argument or filename', () => {
  expect(requestsDockerHostControl('git commit -m "add docker support"')).toBe(false);
  expect(requestsDockerHostControl('cat Dockerfile')).toBe(false);
  expect(requestsDockerHostControl('ls docker/')).toBe(false);
  expect(requestsDockerHostControl('podman ps')).toBe(false);
  expect(requestsDockerHostControl('grep -r docker source')).toBe(false);
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
