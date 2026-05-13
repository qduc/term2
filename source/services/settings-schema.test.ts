import test from 'ava';

import { CustomProviderSchema, KNOWN_CUSTOM_PROVIDER_TYPES, isKnownCustomProviderType } from './settings-schema.js';

test('CustomProviderSchema defaults provider type for legacy configs', (t) => {
  const parsed = CustomProviderSchema.parse({
    name: 'local',
    baseUrl: 'http://localhost:11434/v1',
  });

  t.is(parsed.type, 'openai-compatible');
});

test('CustomProviderSchema accepts known provider types', (t) => {
  for (const providerType of KNOWN_CUSTOM_PROVIDER_TYPES) {
    const parsed = CustomProviderSchema.parse({
      name: `provider-${providerType}`,
      type: providerType,
      baseUrl: 'http://localhost:11434/v1',
    });

    t.is(parsed.type, providerType);
    t.true(isKnownCustomProviderType(providerType));
  }
});

test('CustomProviderSchema accepts llama.cpp as an OpenAI-compatible provider variant', (t) => {
  const parsed = CustomProviderSchema.parse({
    name: 'local',
    type: 'llama.cpp',
    baseUrl: 'http://localhost:11434/v1',
  });

  t.is(parsed.type, 'llama.cpp');
  t.true(isKnownCustomProviderType('llama.cpp'));
});

test('CustomProviderSchema rejects provider types outside the known list', (t) => {
  const error = t.throws(() =>
    CustomProviderSchema.parse({
      name: 'local',
      type: 'unknown-provider',
      baseUrl: 'http://localhost:11434/v1',
    }),
  );

  t.truthy(error);
  t.false(isKnownCustomProviderType('unknown-provider'));
});

test('CustomProviderSchema rejects invalid provider type format', (t) => {
  const error = t.throws(() =>
    CustomProviderSchema.parse({
      name: 'local',
      type: 'bad type!',
      baseUrl: 'http://localhost:11434/v1',
    }),
  );

  t.truthy(error);
});

test('CustomProviderSchema allows anthropic type without baseUrl', (t) => {
  const parsed = CustomProviderSchema.parse({
    name: 'my-anthropic',
    type: 'anthropic',
  });

  t.is(parsed.type, 'anthropic');
  t.is(parsed.baseUrl, undefined);
});

test('CustomProviderSchema allows google type without baseUrl', (t) => {
  const parsed = CustomProviderSchema.parse({
    name: 'my-google',
    type: 'google',
  });

  t.is(parsed.type, 'google');
  t.is(parsed.baseUrl, undefined);
});

test('CustomProviderSchema rejects openai-compatible type without baseUrl', (t) => {
  const error = t.throws(() =>
    CustomProviderSchema.parse({
      name: 'local',
      type: 'openai-compatible',
    }),
  );

  t.truthy(error);
});

test('CustomProviderSchema rejects openai type without baseUrl', (t) => {
  const error = t.throws(() =>
    CustomProviderSchema.parse({
      name: 'local',
      type: 'openai',
    }),
  );

  t.truthy(error);
});
