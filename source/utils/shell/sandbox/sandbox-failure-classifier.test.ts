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
