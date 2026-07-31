import { expect, it } from 'vitest';
import { ProviderContinuity } from './provider-continuity.js';
import { ProviderContinuityOpenAIRootSelectorParityObserver } from './openai-root-selector-parity-observer.js';

const checkpoint = (continuity: ProviderContinuity, responseId = 'resp-accepted') => {
  const binding = {
    identity: { provider: 'openai', endpoint: 'responses', model: 'gpt-5' },
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
  const observer = new ProviderContinuityOpenAIRootSelectorParityObserver(continuity, () => 'gpt-5');
  observer.setEvidenceRecorder((value) => evidence.push(value));

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
  });

  expect(evidence).toEqual([{ type: 'openai_root_selector_parity', version: 1, eligible: true, matches: true }]);
  expect(observer.latestObservation).toEqual({
    eligible: true,
    legacyPreviousResponseId: 'resp-accepted',
    acceptedCheckpointResponseId: 'resp-accepted',
    matches: true,
  });
  expect(Object.isFrozen(observer.latestObservation)).toBe(true);
  expect(Object.isFrozen(evidence[0])).toBe(true);
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
  ],
  ['same revision', 'resp-accepted', 'gpt-5', 'history:test', 2, [{ role: 'user', content: 'before' }]],
])('fails closed for %s', (_name, legacyPreviousResponseId, model, origin, revision, history) => {
  const continuity = new ProviderContinuity();
  checkpoint(continuity);
  const evidence: any[] = [];
  const observer = new ProviderContinuityOpenAIRootSelectorParityObserver(
    continuity,
    () => model,
    (value) => evidence.push(value),
  );

  observer.observe({
    legacyPreviousResponseId,
    plannedSnapshot: { identity: `history:test:${revision}`, origin, revision, history } as any,
  });

  expect(evidence[0]).toEqual({ type: 'openai_root_selector_parity', version: 1, eligible: false, matches: false });
});

it('records an eligible checkpoint as a non-match when the legacy response differs', () => {
  const continuity = new ProviderContinuity();
  checkpoint(continuity);
  const evidence: any[] = [];
  const observer = new ProviderContinuityOpenAIRootSelectorParityObserver(
    continuity,
    () => 'gpt-5',
    (value) => evidence.push(value),
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

  expect(evidence[0]).toEqual({ type: 'openai_root_selector_parity', version: 1, eligible: true, matches: false });
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
  );

  expect(() =>
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
  ).not.toThrow();
  expect(observer.latestObservation).toMatchObject({ eligible: true, matches: true });
});
