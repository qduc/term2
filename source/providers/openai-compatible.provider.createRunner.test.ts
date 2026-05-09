import test from 'ava';
import { createOpenAICompatibleProviderDefinition } from './openai-compatible.provider.js';
import type { ProviderDeps } from './registry.js';

test('runtime openai-compatible createRunner returns a runner', (t) => {
  const provider = createOpenAICompatibleProviderDefinition({
    name: 'local-test',
    baseUrl: 'http://localhost:11434',
  });

  const deps: ProviderDeps = {
    settingsService: {
      get: <T = any>(key: string) => {
        const values: Record<string, any> = {
          'agent.model': 'test-model',
          providers: [
            {
              name: 'local-test',
              baseUrl: 'http://localhost:11434',
              apiKey: 'local-key',
            },
          ],
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

  const runner = provider.createRunner!(deps);

  t.truthy(runner);
});
