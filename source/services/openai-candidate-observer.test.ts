import { expect, it } from 'vitest';
import { OpenAICandidateObserver } from './openai-candidate-observer.js';
import { ProviderContinuity } from './provider-continuity.js';

const terminal = (overrides: Record<string, unknown> = {}) => ({
  token: 'attempt-1',
  provider: 'openai' as const,
  transport: 'http' as const,
  model: 'gpt-5',
  endpoint: 'https://api.openai.com/v1',
  requestData: {},
  phase: 'terminal' as const,
  responseId: 'resp-1',
  prefixBinding: { snapshotIdentity: 'history:1', snapshotRevision: 1, lineage: 0 },
  ...overrides,
});

it('creates a candidate only for a terminal OpenAI observation with an exact bound response', () => {
  const continuity = new ProviderContinuity();
  new OpenAICandidateObserver(continuity).observe(terminal());

  expect(continuity.checkpoint).toMatchObject({
    state: 'candidate',
    responseId: 'resp-1',
    identity: { provider: 'openai', endpoint: 'https://api.openai.com/v1', model: 'gpt-5' },
    prefix: { identity: 'history:1', revision: 1 },
  });
});

it.each([
  ['missing response ID', { responseId: undefined }],
  ['missing binding', { prefixBinding: undefined }],
  ['failed attempt', { phase: 'failed' }],
  ['abandoned attempt', { phase: 'abandoned' }],
])('ignores %s', (_name, overrides) => {
  const continuity = new ProviderContinuity();
  new OpenAICandidateObserver(continuity).observe(terminal(overrides) as any);
  expect(continuity.checkpoint).toBeNull();
});

it('rejects a terminal observation captured before reset', () => {
  const continuity = new ProviderContinuity();
  continuity.clear();
  new OpenAICandidateObserver(continuity).observe(terminal());
  expect(continuity.checkpoint).toBeNull();
});

it('swallows continuity observer failures', () => {
  const observer = new OpenAICandidateObserver({
    observeCandidate: () => {
      throw new Error('nope');
    },
  } as any);
  expect(() => observer.observe(terminal())).not.toThrow();
});
