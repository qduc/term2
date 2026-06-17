import { it, expect } from 'vitest';
import { logCommandExecution } from './command-logger.js';

const buildSettingsService = (overrides: Record<string, unknown> = {}) => ({
  get: <T = unknown>(key: string): T => {
    switch (key) {
      case 'debug.debugBashTool':
        return true as T;
      case 'logging.suppressConsoleOutput':
        return true as T;
      case 'environment.nodeEnv':
        return 'test' as T;
      default:
        return overrides[key] as T;
    }
  },
  set: () => {},
});

it('logCommandExecution does not write to console when suppressed', () => {
  const originalConsoleError = console.error;
  const calls: string[][] = [];

  console.error = (...args) => {
    calls.push(args);
  };

  try {
    logCommandExecution(buildSettingsService(), 'echo hi', false, true);

    expect(calls.length).toBe(0);
  } finally {
    console.error = originalConsoleError;
  }
});
