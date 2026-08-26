import { expect, it } from 'vitest';
import { getProvider } from './index.js';

const deps: any = {
  settingsService: { get: (key: string) => (key === 'agent.openrouter.apiKey' ? 'sk-test' : undefined), set: () => {} },
  loggingService: {
    info() {},
    warn() {},
    error() {},
    debug() {},
    security() {},
    setCorrelationId() {},
    getCorrelationId() {},
    clearCorrelationId() {},
  },
};

it('openrouter exposes an application-owned model factory without requiring a runner', () => {
  const provider = getProvider('openrouter');
  expect(typeof provider?.createStreamedModel).toBe('function');
});

it('openrouter application model factory uses configured credentials and wraps in RetryingModel', () => {
  const provider = getProvider('openrouter');
  const model = provider!.createStreamedModel!('openrouter/auto', deps);
  expect(model).toBeTruthy();
  expect(typeof (model as any).stream).toBe('function');
  expect((model as any).wrappedModel).toBeTruthy();
});
