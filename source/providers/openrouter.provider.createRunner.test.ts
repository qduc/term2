import { it, expect } from 'vitest';
import { getProvider } from './index.js';
import type { ProviderDeps } from './registry.js';

it('openrouter createRunner does not crash in ESM when api key is missing', () => {
  const originalKey = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  try {
    const provider = getProvider('openrouter');
    expect(provider).toBeTruthy();
    expect(typeof provider?.createRunner).toBe('function');

    const deps: ProviderDeps = {
      settingsService: {
        get: <T = any>() => undefined as T,
        set: () => {},
      },
      loggingService: {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
        security: () => {},
        setCorrelationId: () => {},
        getCorrelationId: () => undefined,
        clearCorrelationId: () => {},
      },
    };

    // This must not throw "ReferenceError: require is not defined" under ESM.
    let runner: any = 'unset';
    expect(() => {
      runner = provider!.createRunner!(deps);
    }).not.toThrow();

    // With no API key, the OpenRouter provider should opt out (null runner).
    expect(runner).toBe(null);
  } finally {
    process.env.OPENROUTER_API_KEY = originalKey;
  }
});

it('openrouter createRunner returns a runner when api key is configured', () => {
  const provider = getProvider('openrouter');
  expect(provider).toBeTruthy();

  const deps: ProviderDeps = {
    settingsService: {
      get: <T = any>(key: string) => {
        const values: Record<string, any> = {
          'agent.openrouter.apiKey': 'sk-test',
          'agent.model': 'openrouter/auto',
        };
        return values[key] as T;
      },
      set: () => {},
    },
    loggingService: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
      security: () => {},
      setCorrelationId: () => {},
      getCorrelationId: () => undefined,
      clearCorrelationId: () => {},
    },
  };

  const runner = provider!.createRunner!(deps);

  expect(runner).toBeTruthy();
});
