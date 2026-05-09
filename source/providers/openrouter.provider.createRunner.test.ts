import test from 'ava';
import { getProvider } from './index.js';
import type { ProviderDeps } from './registry.js';

test('openrouter createRunner does not crash in ESM when api key is missing', (t) => {
  const provider = getProvider('openrouter');
  t.truthy(provider, 'openrouter provider should be registered');
  t.is(typeof provider?.createRunner, 'function');

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
  t.notThrows(() => {
    runner = provider!.createRunner!(deps);
  });

  // With no API key, the OpenRouter provider should opt out (null runner).
  t.is(runner, null);
});

test('openrouter createRunner returns a runner when api key is configured', (t) => {
  const provider = getProvider('openrouter');
  t.truthy(provider, 'openrouter provider should be registered');

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

  t.truthy(runner);
});
