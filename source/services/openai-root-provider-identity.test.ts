import { expect, it } from 'vitest';
import { OpenAIRootProviderIdentity } from './openai-root-provider-identity.js';
import type { ProviderCheckpointIdentity } from './provider-continuity.js';

const resolvedIdentity = (): ProviderCheckpointIdentity => ({
  provider: 'openai',
  endpoint: 'https://api.openai.com/v1',
  model: 'gpt-5',
});

const partialIdentity = (missing: 'provider' | 'endpoint' | 'model'): ProviderCheckpointIdentity => {
  const identity = resolvedIdentity();
  identity[missing] = '';
  return identity;
};

it('freezes and exposes a complete observed identity via current', () => {
  const identity = new OpenAIRootProviderIdentity();
  const observed = resolvedIdentity();

  identity.observe(observed);

  expect(identity.current).toEqual(observed);
  expect(Object.isFrozen(identity.current)).toBe(true);
});

it('keeps the observed identity independent of later mutation of the caller object', () => {
  const identity = new OpenAIRootProviderIdentity();
  const observed = resolvedIdentity();

  identity.observe(observed);
  observed.model = 'mutated-after-observe';

  expect(identity.current?.model).toBe('gpt-5');
});

it('retains the previous identity when an observation is missing any one field', () => {
  const identity = new OpenAIRootProviderIdentity();
  identity.observe(resolvedIdentity());
  const retained = identity.current;

  for (const missing of ['provider', 'endpoint', 'model'] as const) {
    identity.observe(partialIdentity(missing));
    expect(identity.current).toBe(retained);
  }
});

it('leaves current null when an observation is incomplete and nothing was retained', () => {
  const identity = new OpenAIRootProviderIdentity();

  for (const missing of ['provider', 'endpoint', 'model'] as const) {
    identity.observe(partialIdentity(missing));
  }

  expect(identity.current).toBeNull();
});

it('replaces the retained identity when a second complete identity is observed', () => {
  const identity = new OpenAIRootProviderIdentity();
  const first = resolvedIdentity();
  const replacement: ProviderCheckpointIdentity = {
    provider: 'openai',
    endpoint: 'https://api.openai.com/v1',
    model: 'gpt-5.1',
  };

  identity.observe(first);
  identity.observe(replacement);

  expect(identity.current).toEqual(replacement);
  expect(identity.current?.model).toBe('gpt-5.1');
});
