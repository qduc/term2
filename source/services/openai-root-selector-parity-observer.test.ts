import { expect, it } from 'vitest';
import { ProviderContinuity } from './provider-continuity.js';
import { ProviderContinuityOpenAIRootSelectorParityObserver } from './openai-root-selector-parity-observer.js';

const resolvedIdentity = () => ({ provider: 'openai', endpoint: 'https://api.openai.com/v1', model: 'gpt-5' });

const checkpoint = (
  continuity: ProviderContinuity,
  responseId = 'resp-accepted',
  endpoint = 'https://api.openai.com/v1',
) => {
  const binding = {
    // OpenAI lifecycle candidates retain the actual resolved client base URL,
    // not a route label. Keep this fixture aligned with the production default.
    identity: { provider: 'openai', endpoint, model: 'gpt-5' },
    prefix: { identity: 'history:test:1', revision: 1 },
  };
  continuity.observeCandidate({ ...binding, responseId });
  continuity.publishTerminalResponse(responseId, true, {
    identity: 'history:test:2',
    origin: 'history:test',
    revision: 2,
    history: [{ role: 'user', content: 'before' }],
  });
};

it('records equality only for an eligible accepted OpenAI checkpoint', () => {
  const continuity = new ProviderContinuity();
  checkpoint(continuity);
  const evidence: any[] = [];
  const observer = new ProviderContinuityOpenAIRootSelectorParityObserver(
    continuity,
    () => 'gpt-5',
    undefined,
    resolvedIdentity,
  );
  observer.setEvidenceRecorder((value) => evidence.push(value));

  const observation = observer.observe({
    legacyPreviousResponseId: 'resp-accepted',
    plannedSnapshot: {
      identity: 'history:test:3',
      origin: 'history:test',
      revision: 3,
      history: [
        { role: 'user', content: 'before' },
        { role: 'user', content: 'next' },
      ],
    },
  });

  expect(evidence).toEqual([{ type: 'openai_root_selector_parity', version: 2, eligible: true, matches: true }]);
  expect(observation).toEqual({
    eligible: true,
    legacyPreviousResponseId: 'resp-accepted',
    acceptedCheckpointResponseId: 'resp-accepted',
    matches: true,
  });
  expect(observer.latestObservation).toEqual({
    eligible: true,
    legacyPreviousResponseId: 'resp-accepted',
    acceptedCheckpointResponseId: 'resp-accepted',
    matches: true,
  });
  expect(Object.isFrozen(observer.latestObservation)).toBe(true);
  expect(Object.isFrozen(evidence[0])).toBe(true);
});

it('uses the shared resolved custom endpoint rather than a route label', () => {
  const continuity = new ProviderContinuity();
  const endpoint = 'https://openai.example.test/v1';
  checkpoint(continuity, 'resp-custom', endpoint);
  const evidence: any[] = [];
  const observer = new ProviderContinuityOpenAIRootSelectorParityObserver(
    continuity,
    () => 'gpt-5',
    (value) => evidence.push(value),
    () => ({ provider: 'openai', endpoint, model: 'gpt-5' }),
  );

  observer.observe({
    legacyPreviousResponseId: 'resp-custom',
    plannedSnapshot: {
      identity: 'history:test:3',
      origin: 'history:test',
      revision: 3,
      history: [
        { role: 'user', content: 'before' },
        { role: 'user', content: 'next' },
      ],
    },
  });

  expect(evidence).toEqual([{ type: 'openai_root_selector_parity', version: 2, eligible: true, matches: true }]);
});

it.each([
  [
    'model mismatch',
    'resp-accepted',
    'gpt-6',
    'history:test',
    3,
    [
      { role: 'user', content: 'before' },
      { role: 'user', content: 'next' },
    ],
    'identity_mismatch',
  ],
  [
    'origin mismatch',
    'resp-accepted',
    'gpt-5',
    'history:other',
    3,
    [
      { role: 'user', content: 'before' },
      { role: 'user', content: 'next' },
    ],
    'origin_mismatch',
  ],
  [
    'rewritten prefix',
    'resp-accepted',
    'gpt-5',
    'history:test',
    3,
    [
      { role: 'user', content: 'rewritten' },
      { role: 'user', content: 'next' },
    ],
    'history_prefix_mismatch',
  ],
  [
    'same revision',
    'resp-accepted',
    'gpt-5',
    'history:test',
    2,
    [{ role: 'user', content: 'before' }],
    'revision_not_advanced',
  ],
])(
  'records the fixed failure enum for %s',
  (_name, legacyPreviousResponseId, model, origin, revision, history, failure) => {
    const continuity = new ProviderContinuity();
    checkpoint(continuity);
    const evidence: any[] = [];
    const observer = new ProviderContinuityOpenAIRootSelectorParityObserver(
      continuity,
      () => model,
      (value) => evidence.push(value),
      resolvedIdentity,
    );

    observer.observe({
      legacyPreviousResponseId,
      plannedSnapshot: { identity: `history:test:${revision}`, origin, revision, history } as any,
    });

    expect(evidence[0]).toEqual({
      type: 'openai_root_selector_parity',
      version: 2,
      eligible: false,
      matches: false,
      failure,
    });
  },
);

it('records model_unavailable without provider metadata', () => {
  const evidence: any[] = [];
  const observer = new ProviderContinuityOpenAIRootSelectorParityObserver(
    new ProviderContinuity(),
    () => undefined,
    (value) => evidence.push(value),
    resolvedIdentity,
  );

  observer.observe({
    legacyPreviousResponseId: 'resp-legacy',
    plannedSnapshot: { identity: 'history:test:1', origin: 'history:test', revision: 1, history: [] },
  });

  expect(evidence).toEqual([
    { type: 'openai_root_selector_parity', version: 2, eligible: false, matches: false, failure: 'model_unavailable' },
  ]);
});

it('fails closed when the root client has not resolved an OpenAI endpoint', () => {
  const evidence: any[] = [];
  const observer = new ProviderContinuityOpenAIRootSelectorParityObserver(
    new ProviderContinuity(),
    () => 'gpt-5',
    (value) => evidence.push(value),
  );

  observer.observe({
    legacyPreviousResponseId: 'resp-legacy',
    plannedSnapshot: { identity: 'history:test:1', origin: 'history:test', revision: 1, history: [] },
  });

  expect(evidence).toEqual([
    {
      type: 'openai_root_selector_parity',
      version: 2,
      eligible: false,
      matches: false,
      failure: 'identity_unavailable',
    },
  ]);
});

it('records an eligible checkpoint as a non-match when the legacy response differs', () => {
  const continuity = new ProviderContinuity();
  checkpoint(continuity);
  const evidence: any[] = [];
  const observer = new ProviderContinuityOpenAIRootSelectorParityObserver(
    continuity,
    () => 'gpt-5',
    (value) => evidence.push(value),
    resolvedIdentity,
  );

  observer.observe({
    legacyPreviousResponseId: 'resp-other',
    plannedSnapshot: {
      identity: 'history:test:3',
      origin: 'history:test',
      revision: 3,
      history: [
        { role: 'user', content: 'before' },
        { role: 'user', content: 'next' },
      ],
    },
  });

  expect(evidence[0]).toEqual({ type: 'openai_root_selector_parity', version: 2, eligible: true, matches: false });
});

it('swallows an evidence-recorder failure after retaining the local observation', () => {
  const continuity = new ProviderContinuity();
  checkpoint(continuity);
  const observer = new ProviderContinuityOpenAIRootSelectorParityObserver(
    continuity,
    () => 'gpt-5',
    () => {
      throw new Error('diagnostics unavailable');
    },
    resolvedIdentity,
  );

  const decision = observer.observe({
    legacyPreviousResponseId: 'resp-accepted',
    plannedSnapshot: {
      identity: 'history:test:3',
      origin: 'history:test',
      revision: 3,
      history: [
        { role: 'user', content: 'before' },
        { role: 'user', content: 'next' },
      ],
    },
  });
  expect(decision).toEqual({
    eligible: false,
    legacyPreviousResponseId: 'resp-accepted',
    acceptedCheckpointResponseId: null,
    matches: false,
  });
  expect(observer.latestObservation).toMatchObject({ eligible: true, matches: true });
});

it('returns a fail-closed decision when checkpoint eligibility throws', () => {
  const continuity = new ProviderContinuity();
  checkpoint(continuity);
  const observer = new ProviderContinuityOpenAIRootSelectorParityObserver(
    continuity,
    () => 'gpt-5',
    undefined,
    () => {
      throw new Error('identity unavailable');
    },
  );

  expect(
    observer.observe({
      legacyPreviousResponseId: 'resp-accepted',
      plannedSnapshot: {
        identity: 'history:test:3',
        origin: 'history:test',
        revision: 3,
        history: [
          { role: 'user', content: 'before' },
          { role: 'user', content: 'next' },
        ],
      },
    }),
  ).toEqual({
    eligible: false,
    legacyPreviousResponseId: 'resp-accepted',
    acceptedCheckpointResponseId: null,
    matches: false,
  });
});
