import { describe, expect, it } from 'vitest';
import { classifySandboxFailure } from './sandbox-failure-classifier.js';

describe('classifySandboxFailure', () => {
  it('classifies sandbox runtime annotations as generic blocked commands', () => {
    const result = classifySandboxFailure({
      command: 'curl https://example.com',
      rawStderr: 'curl: failed',
      annotatedStderr:
        'curl: failed\n<sandbox_violations>\nSandbox: curl(123) deny network-outbound\n</sandbox_violations>',
      sandboxed: true,
      readPolicy: 'standard',
    });

    expect(result).toEqual({
      type: 'blocked',
      reason: 'unknown',
      confidence: 'runtime_annotation',
      stderr: 'curl: failed\n<sandbox_violations>\nSandbox: curl(123) deny network-outbound\n</sandbox_violations>',
    });
  });

  it('classifies proxy allowlist blocks as network sandbox failures', () => {
    const result = classifySandboxFailure({
      command: 'curl https://not-allowed.example',
      rawStderr: 'HTTP/1.1 403 Forbidden\nblocked-by-allowlist',
      annotatedStderr: 'HTTP/1.1 403 Forbidden\nblocked-by-allowlist',
      sandboxed: true,
      readPolicy: 'standard',
    });

    expect(result).toEqual({
      type: 'blocked',
      reason: 'network',
      confidence: 'stderr_pattern',
      stderr: 'HTTP/1.1 403 Forbidden\nblocked-by-allowlist',
    });
  });

  it('classifies strict denied reads separately so the approval flow can retry the same command', () => {
    const result = classifySandboxFailure({
      command: 'cat ~/.cargo/registry/cache',
      rawStderr: 'cat: error',
      annotatedStderr:
        'cat: error\n<sandbox_violations>\nSandbox: cat(123) deny file-read* /home/testuser/.cargo/registry/cache\n</sandbox_violations>',
      sandboxed: true,
      readPolicy: 'strict',
    });

    expect(result).toEqual({
      type: 'denied_read',
      confidence: 'runtime_annotation',
      stderr:
        'cat: error\n<sandbox_violations>\nSandbox: cat(123) deny file-read* /home/testuser/.cargo/registry/cache\n</sandbox_violations>',
      deniedRead: {
        path: '/home/testuser/.cargo/registry/cache',
        suggestedParent: '/home/testuser/.cargo/registry',
        sensitive: false,
      },
    });
  });

  it('classifies a blocked Docker daemon connection so the approval flow can offer host control', () => {
    const stderr =
      'WARNING: Error loading config file: open /Users/me/.docker/config.json: operation not permitted\n' +
      'permission denied while trying to connect to the docker API at unix:///var/run/docker.sock';

    expect(
      classifySandboxFailure({
        command: 'pnpm test',
        rawStderr: stderr,
        annotatedStderr: stderr,
        sandboxed: true,
        readPolicy: 'standard',
      }),
    ).toEqual({ type: 'docker_blocked', confidence: 'stderr_pattern', stderr });
  });

  it('classifies the daemon-unreachable form Docker reports when it loses its context', () => {
    const stderr = 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?';

    expect(
      classifySandboxFailure({
        command: 'make up',
        rawStderr: stderr,
        annotatedStderr: stderr,
        sandboxed: true,
        readPolicy: 'standard',
      })?.type,
    ).toBe('docker_blocked');
  });

  it('does not swallow the output of a command that succeeded while mentioning the daemon', () => {
    const stderr = 'note: cannot connect to the Docker daemon (ignored)';

    expect(
      classifySandboxFailure({
        command: 'pnpm test',
        rawStderr: stderr,
        annotatedStderr: stderr,
        sandboxed: true,
        readPolicy: 'standard',
        exitCode: 0,
      }),
    ).toBeNull();
  });

  it('does not blame the sandbox when the command already held Docker host control', () => {
    const stderr = 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?';

    expect(
      classifySandboxFailure({
        command: 'docker ps',
        rawStderr: stderr,
        annotatedStderr: stderr,
        sandboxed: true,
        readPolicy: 'standard',
        dockerHostControlActive: true,
      }),
    ).toBeNull();
  });

  it('does not classify ordinary stderr when no sandbox signal is present', () => {
    const result = classifySandboxFailure({
      command: 'cat ./private-file',
      rawStderr: 'cat: ./private-file: Permission denied',
      annotatedStderr: 'cat: ./private-file: Permission denied',
      sandboxed: true,
      readPolicy: 'standard',
    });

    expect(result).toBeNull();
  });
});
