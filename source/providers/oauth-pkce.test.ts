import { describe, expect, it, vi, beforeEach } from 'vitest';
import EventEmitter from 'node:events';

let spawnImplementation: ((command: string, args: string[], options: any) => any) | null = null;

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (command: string, args: string[], options: any) => {
      if (spawnImplementation) {
        return spawnImplementation(command, args, options);
      }
      return actual.spawn(command, args, options);
    },
  };
});

import { openInBrowser } from './oauth-pkce.js';

describe('openInBrowser', () => {
  beforeEach(() => {
    spawnImplementation = null;
  });

  it('does not throw or emit unhandled error when spawn fails asynchronously (e.g. xdg-open ENOENT)', async () => {
    const fakeChild = new EventEmitter() as any;
    fakeChild.unref = vi.fn();

    let spawned = false;
    spawnImplementation = () => {
      spawned = true;
      process.nextTick(() => {
        const error = new Error('spawn xdg-open ENOENT') as any;
        error.code = 'ENOENT';
        fakeChild.emit('error', error);
      });
      return fakeChild;
    };

    expect(() => {
      openInBrowser('https://example.com/oauth/authorize');
    }).not.toThrow();

    expect(spawned).toBe(true);
    expect(fakeChild.unref).toHaveBeenCalled();

    // Wait a tick for the error event to fire
    await new Promise((resolve) => process.nextTick(resolve));
  });

  it('handles synchronous spawn throw gracefully', () => {
    spawnImplementation = () => {
      throw new Error('Sync spawn error');
    };

    expect(() => {
      openInBrowser('https://example.com/oauth/authorize');
    }).not.toThrow();
  });
});
