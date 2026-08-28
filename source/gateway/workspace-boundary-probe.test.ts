import { constants } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createRealWorkspaceBoundaryProbe } from './workspace-boundary-probe.js';

const baseFs = {
  realpathSync: (value: string) => value,
  statSync: () => ({ isDirectory: () => true }),
  accessSync: (_value: string, _mode: number) => undefined,
};

describe('createRealWorkspaceBoundaryProbe', () => {
  it('requires canonical readable roots and reports physical write evidence', () => {
    const modes: number[] = [];
    const probe = createRealWorkspaceBoundaryProbe({
      allowWrite: true,
      fs: { ...baseFs, accessSync: (_value, mode) => modes.push(mode) },
    });
    expect(probe('/workspace', 'read_write')).toEqual({ mountedRoot: '/workspace', writable: true });
    expect(modes).toEqual([constants.R_OK | constants.X_OK, constants.W_OK]);
  });

  it('fails closed for a swapped/non-directory root and launcher write policy', () => {
    expect(
      createRealWorkspaceBoundaryProbe({
        allowWrite: true,
        fs: { ...baseFs, realpathSync: () => '/other' },
      })('/workspace', 'read_write'),
    ).toBe(false);
    expect(createRealWorkspaceBoundaryProbe({ allowWrite: false, fs: baseFs })('/workspace', 'read_write')).toEqual({
      mountedRoot: '/workspace',
      writable: false,
      policy: 'read_only_launcher',
    });
  });

  it('reports a read-only boundary when the OS denies W_OK', () => {
    const probe = createRealWorkspaceBoundaryProbe({
      allowWrite: true,
      fs: {
        ...baseFs,
        accessSync: (_value, mode) => {
          if (mode === constants.W_OK) throw new Error('read only mount');
        },
      },
    });
    expect(probe('/workspace', 'read')).toEqual({ mountedRoot: '/workspace', writable: false });
  });
});
