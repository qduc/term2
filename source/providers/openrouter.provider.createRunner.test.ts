import test from 'ava';
import { getProvider } from './index.js';

test('openrouter createRunner does not crash in ESM when api key is missing', (t) => {
  const provider = getProvider('openrouter');
  t.truthy(provider, 'openrouter provider should be registered');
  t.is(typeof provider?.createRunner, 'function');

  // This must not throw "ReferenceError: require is not defined" under ESM.
  let runner: any = 'unset';
  t.notThrows(() => {
    runner = (provider!.createRunner as any)({
      settingsService: { get: () => undefined },
      loggingService: {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
      },
    });
  });

  // With no API key, the OpenRouter provider should opt out (null runner).
  t.is(runner, null);
});
