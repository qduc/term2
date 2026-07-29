import { it, expect } from 'vitest';
import { ProviderContinuity } from './provider-continuity.js';

it('initial state is clear', () => {
  const pc = new ProviderContinuity();
  expect(pc.previousResponseId).toBe(null);
  expect(pc.chainingBroken).toBe(false);
  expect(pc.isChainingAvailable(2)).toBe(false);
  expect(pc.isChainingAvailable(1)).toBe(true);
});

it('update sets previousResponseId', () => {
  const pc = new ProviderContinuity();
  pc.update('resp-1');
  expect(pc.previousResponseId).toBe('resp-1');
  expect(pc.chainingBroken).toBe(false);
});

it('clear resets previousResponseId', () => {
  const pc = new ProviderContinuity();
  pc.update('resp-1');
  pc.clear();
  expect(pc.previousResponseId).toBe(null);
});

it('breakChaining marks chaining broken and clears previousResponseId', () => {
  const pc = new ProviderContinuity();
  pc.update('resp-1');
  pc.breakChaining();
  expect(pc.previousResponseId).toBe(null);
  expect(pc.chainingBroken).toBe(true);
});

it('isChainingAvailable requires previousResponseId or short history and unbroken chaining', () => {
  const pc = new ProviderContinuity();
  expect(pc.isChainingAvailable(2)).toBe(false);
  expect(pc.isChainingAvailable(1)).toBe(true);
  pc.update('resp-1');
  expect(pc.isChainingAvailable(2)).toBe(true);
  pc.breakChaining();
  expect(pc.isChainingAvailable(1)).toBe(false);
  expect(pc.isChainingAvailable(2)).toBe(false);
});

it('update after breakChaining keeps chaining broken', () => {
  const pc = new ProviderContinuity();
  pc.breakChaining();
  pc.update('resp-2');
  expect(pc.previousResponseId).toBe('resp-2');
  expect(pc.chainingBroken).toBe(true);
  expect(pc.isChainingAvailable()).toBe(false);
});

it('keeps a candidate checkpoint separate from existing previousResponseId behavior until terminal acceptance', () => {
  const pc = new ProviderContinuity();
  const binding = {
    identity: { provider: 'openai', account: 'account-1', endpoint: 'responses', model: 'gpt-5' },
    prefix: { revision: 4, identity: 'history:4' },
  };

  expect(pc.observeCandidate({ ...binding, responseId: 'resp-candidate', opaqueState: { transport: 'ws' } })).toBe(
    true,
  );
  expect(pc.previousResponseId).toBeNull();
  expect(pc.checkpoint).toMatchObject({ state: 'candidate', responseId: 'resp-candidate', ...binding });

  pc.update('resp-existing-wire-state');
  expect(pc.previousResponseId).toBe('resp-existing-wire-state');
  expect(pc.promoteCandidate('resp-candidate')).toBe(true);
  expect(pc.checkpoint).toMatchObject({ state: 'accepted', responseId: 'resp-candidate', ...binding });
});

it('retires a prior lineage and rejects its late candidate promotion after reset', () => {
  const pc = new ProviderContinuity();
  const binding = {
    identity: { provider: 'codex', account: 'account-1', endpoint: 'responses', model: 'gpt-5-codex' },
    prefix: { revision: 7, identity: 'history:7' },
  };

  pc.observeCandidate({ ...binding, responseId: 'resp-old' });
  pc.clear();

  expect(pc.checkpoint).toBeNull();
  expect(pc.retiredCheckpoints).toMatchObject([{ state: 'retired', responseId: 'resp-old', ...binding }]);
  expect(pc.promoteCandidate('resp-old')).toBe(false);
  expect(pc.observeCandidate({ ...binding, lineage: 0, responseId: 'resp-late' })).toBe(false);
});

it('requires the exact current identity and transcript prefix to accept a checkpoint candidate', () => {
  const pc = new ProviderContinuity();
  const binding = {
    identity: { provider: 'openai', account: 'account-1', endpoint: 'responses', model: 'gpt-5' },
    prefix: { revision: 2, identity: 'history:2' },
  };

  pc.observeCandidate({ ...binding, responseId: 'resp-1' });
  expect(
    pc.promoteCandidate('resp-1', {
      ...binding,
      prefix: { revision: 3, identity: 'history:3' },
    }),
  ).toBe(false);
  expect(pc.checkpoint?.state).toBe('candidate');
  expect(pc.promoteCandidate('resp-1', binding)).toBe(true);
});
