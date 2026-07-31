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
    identity: { provider: 'openai', endpoint: 'responses', model: 'gpt-5' },
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

it('publishes the legacy response ID and accepts only a matching committed candidate', () => {
  const pc = new ProviderContinuity();
  const binding = {
    identity: { provider: 'openai', endpoint: 'responses', model: 'gpt-5' },
    prefix: { revision: 4, identity: 'history:4' },
  };
  pc.observeCandidate({ ...binding, responseId: 'resp-candidate' });

  expect(pc.publishTerminalResponse('resp-other', true)).toBe(false);
  expect(pc.previousResponseId).toBe('resp-other');
  expect(pc.checkpoint).toMatchObject({ state: 'candidate', responseId: 'resp-candidate' });

  expect(pc.publishTerminalResponse('resp-candidate', false)).toBe(false);
  expect(pc.previousResponseId).toBe('resp-candidate');
  expect(pc.checkpoint).toMatchObject({ state: 'candidate', responseId: 'resp-candidate' });

  expect(pc.publishTerminalResponse('resp-candidate', true)).toBe(true);
  expect(pc.previousResponseId).toBe('resp-candidate');
  expect(pc.checkpoint).toMatchObject({ state: 'accepted', responseId: 'resp-candidate' });
});

it('records immutable post-commit successor proof only with matching accepted publication', () => {
  const pc = new ProviderContinuity();
  const binding = {
    identity: { provider: 'openai', endpoint: 'responses', model: 'gpt-5' },
    prefix: { revision: 4, identity: 'history:4' },
  };
  const committed = {
    revision: 5,
    identity: 'history:5',
    origin: 'history:session-a',
    history: [
      { role: 'user', content: 'before' },
      { role: 'assistant', content: 'done' },
    ],
  };
  pc.observeCandidate({ ...binding, responseId: 'resp-candidate' });

  expect(pc.publishTerminalResponse('resp-candidate', true, committed)).toBe(true);
  expect(pc.checkpoint?.successorProof).toEqual(committed);
  expect(Object.isFrozen(pc.checkpoint?.successorProof)).toBe(true);
  expect(Object.isFrozen(pc.checkpoint?.successorProof?.history)).toBe(true);
  committed.history[0].content = 'mutated';
  expect(pc.checkpoint?.successorProof?.history[0]).toEqual({ role: 'user', content: 'before' });
});

it.each([
  [
    'matching strict successor',
    { provider: 'openai', endpoint: 'responses', model: 'gpt-5' },
    0,
    'history:session-a',
    6,
    [
      { role: 'user', content: 'before' },
      { role: 'assistant', content: 'done' },
      { role: 'user', content: 'next' },
    ],
    true,
  ],
  [
    'same snapshot',
    { provider: 'openai', endpoint: 'responses', model: 'gpt-5' },
    0,
    'history:session-a',
    5,
    [
      { role: 'user', content: 'before' },
      { role: 'assistant', content: 'done' },
    ],
    false,
  ],
  [
    'rewritten prefix',
    { provider: 'openai', endpoint: 'responses', model: 'gpt-5' },
    0,
    'history:session-a',
    6,
    [
      { role: 'user', content: 'rewritten' },
      { role: 'assistant', content: 'done' },
      { role: 'user', content: 'next' },
    ],
    false,
  ],
  [
    'identity mismatch',
    { provider: 'openai', endpoint: 'other', model: 'gpt-5' },
    0,
    'history:session-a',
    6,
    [
      { role: 'user', content: 'before' },
      { role: 'assistant', content: 'done' },
      { role: 'user', content: 'next' },
    ],
    false,
  ],
  [
    'stale lineage',
    { provider: 'openai', endpoint: 'responses', model: 'gpt-5' },
    1,
    'history:session-a',
    6,
    [
      { role: 'user', content: 'before' },
      { role: 'assistant', content: 'done' },
      { role: 'user', content: 'next' },
    ],
    false,
  ],
  [
    'different transcript origin',
    { provider: 'openai', endpoint: 'responses', model: 'gpt-5' },
    0,
    'history:session-b',
    6,
    [
      { role: 'user', content: 'before' },
      { role: 'assistant', content: 'done' },
      { role: 'user', content: 'next' },
    ],
    false,
  ],
  [
    'shorter planned history',
    { provider: 'openai', endpoint: 'responses', model: 'gpt-5' },
    0,
    'history:session-a',
    6,
    [{ role: 'user', content: 'before' }],
    false,
  ],
])('isEligibleForSuccessor is fail-closed for %s', (_name, identity, lineage, origin, revision, history, expected) => {
  const pc = new ProviderContinuity();
  const binding = {
    identity: { provider: 'openai', endpoint: 'responses', model: 'gpt-5' },
    prefix: { revision: 4, identity: 'history:4' },
  };
  pc.observeCandidate({ ...binding, responseId: 'resp-candidate' });
  pc.publishTerminalResponse('resp-candidate', true, {
    revision: 5,
    identity: 'history:5',
    origin: 'history:session-a',
    history: [
      { role: 'user', content: 'before' },
      { role: 'assistant', content: 'done' },
    ],
  });

  expect(
    pc.isEligibleForSuccessor(identity, lineage, { revision, identity: `history:${revision}`, origin, history }),
  ).toBe(expected);
});

it('isEligibleForSuccessor rejects accepted checkpoints without a post-commit proof and after reset', () => {
  const pc = new ProviderContinuity();
  const binding = {
    identity: { provider: 'openai', endpoint: 'responses', model: 'gpt-5' },
    prefix: { revision: 4, identity: 'history:4' },
  };
  const planned = {
    revision: 6,
    identity: 'history:6',
    origin: 'history:session-a',
    history: [{ role: 'user', content: 'next' }],
  };
  pc.observeCandidate({ ...binding, responseId: 'resp-candidate' });
  pc.promoteCandidate('resp-candidate');
  expect(pc.isEligibleForSuccessor(binding.identity, 0, planned)).toBe(false);
  pc.clear();
  expect(pc.isEligibleForSuccessor(binding.identity, 1, planned)).toBe(false);
});

it('isEligibleForSuccessor rejects malformed planned snapshot evidence', () => {
  const pc = new ProviderContinuity();
  const binding = {
    identity: { provider: 'openai', endpoint: 'responses', model: 'gpt-5' },
    prefix: { revision: 4, identity: 'history:4' },
  };
  pc.observeCandidate({ ...binding, responseId: 'resp-candidate' });
  pc.publishTerminalResponse('resp-candidate', true, {
    revision: 5,
    identity: 'history:5',
    origin: 'history:session-a',
    history: [{ role: 'assistant', content: 'done' }],
  });

  expect(pc.isEligibleForSuccessor(binding.identity, 0, { revision: 6 } as any)).toBe(false);
  expect(pc.isEligibleForSuccessor(binding.identity, 0, null as any)).toBe(false);
});

it('retires a prior lineage and rejects its late candidate promotion after reset', () => {
  const pc = new ProviderContinuity();
  const binding = {
    identity: { provider: 'codex', endpoint: 'responses', model: 'gpt-5-codex' },
    prefix: { revision: 7, identity: 'history:7' },
  };

  pc.observeCandidate({ ...binding, responseId: 'resp-old' });
  pc.clear();

  expect(pc.checkpoint).toBeNull();
  expect(pc.retiredCheckpoints).toMatchObject([
    { state: 'retired', responseId: 'resp-old', retirement: { code: 'reset' }, ...binding },
  ]);
  expect(pc.promoteCandidate('resp-old')).toBe(false);
  expect(pc.observeCandidate({ ...binding, lineage: 0, responseId: 'resp-late' })).toBe(false);
});

it('records candidate, accepted, and superseded checkpoint lifecycle states with the complete binding', () => {
  const pc = new ProviderContinuity();
  const binding = {
    identity: { provider: 'openai', endpoint: 'responses', model: 'gpt-5' },
    prefix: { revision: 2, identity: 'history:2' },
  };

  pc.observeCandidate({ ...binding, responseId: 'resp-1' });
  expect(pc.checkpoint).toEqual({ ...binding, lineage: 0, responseId: 'resp-1', state: 'candidate' });
  expect(pc.promoteCandidate('resp-1', binding)).toBe(true);
  expect(pc.checkpoint).toEqual({ ...binding, lineage: 0, responseId: 'resp-1', state: 'accepted' });

  pc.observeCandidate({ ...binding, responseId: 'resp-2' });
  expect(pc.retiredCheckpoints).toEqual([
    { ...binding, lineage: 0, responseId: 'resp-1', state: 'retired', retirement: { code: 'superseded' } },
  ]);
  expect(pc.checkpoint).toEqual({ ...binding, lineage: 0, responseId: 'resp-2', state: 'candidate' });
});

it.each([
  ['provider', { provider: 'codex' }, 'identity_mismatch', undefined],
  ['endpoint', { endpoint: 'chat-completions' }, 'identity_mismatch', undefined],
  ['model', { model: 'gpt-5-mini' }, 'identity_mismatch', undefined],
  ['prefix revision', {}, 'prefix_mismatch', { revision: 3, identity: 'history:2' }],
  ['prefix identity', {}, 'prefix_mismatch', { revision: 2, identity: 'other-store:2' }],
])('retires a candidate on exact %s binding mismatch', (_field, identityPatch, retirementCode, prefixPatch) => {
  const pc = new ProviderContinuity();
  const binding = {
    identity: { provider: 'openai', endpoint: 'responses', model: 'gpt-5' },
    prefix: { revision: 2, identity: 'store-1:2' },
  };

  pc.observeCandidate({ ...binding, responseId: 'resp-1' });
  expect(
    pc.promoteCandidate('resp-1', {
      identity: { ...binding.identity, ...identityPatch },
      prefix: { ...binding.prefix, ...prefixPatch },
    }),
  ).toBe(false);
  expect(pc.checkpoint).toBeNull();
  expect(pc.retiredCheckpoints).toEqual([
    { ...binding, lineage: 0, responseId: 'resp-1', state: 'retired', retirement: { code: retirementCode } },
  ]);
});

it('retires a candidate when chaining breaks', () => {
  const pc = new ProviderContinuity();
  const binding = {
    identity: { provider: 'openai', endpoint: 'responses', model: 'gpt-5' },
    prefix: { revision: 2, identity: 'store-1:2' },
  };

  pc.observeCandidate({ ...binding, responseId: 'resp-1' });
  pc.breakChaining();
  expect(pc.retiredCheckpoints).toEqual([
    { ...binding, lineage: 0, responseId: 'resp-1', state: 'retired', retirement: { code: 'chaining_broken' } },
  ]);
});
