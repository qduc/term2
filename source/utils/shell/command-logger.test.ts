import test from 'ava';
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

test('logCommandExecution does not write to console when suppressed', (t) => {
  const originalConsoleError = console.error;
  const calls: string[][] = [];

  console.error = (...args) => {
    calls.push(args);
  };

  try {
    logCommandExecution(buildSettingsService(), 'echo hi', false, true);

    t.is(calls.length, 0);
  } finally {
    console.error = originalConsoleError;
  }
});
