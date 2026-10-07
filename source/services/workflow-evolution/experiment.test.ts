import { describe, expect, it } from 'vitest';
import {
  applyEvent,
  digest,
  contentDigest,
  type Experiment,
  type RunRecord,
  type ExperimentEvent,
} from './experiment.js';

const incumbent = { name: 'verify', revision: 'v1', source: 'project/verify', body: 'Check after handoff.' };
const candidate = { ...incumbent, revision: 'v2', body: 'Check before handoff.' };
const criteria = {
  tasks: ['a', 'b', 'c'].map((id) => ({ id, inputDigest: digest(id) })),
  checks: ['artifact-correct', 'preserved'],
  conditions: 'same harness, tools and resource envelope',
  minimumPairs: 3,
  minimumWins: 2,
};
const evidence = [{ ref: 'artifact/check-results.json', digest: digest('oracle') }];
const metrics = { outcome: 'pass' as const, interventions: 0, retries: 0 };

function event(state: Experiment | null, value: unknown) {
  return applyEvent(state, value);
}
function setup() {
  let state = event(null, { type: 'init', id: 'experiment-1', incumbent, criteria });
  for (const id of ['observed-a', 'observed-b']) {
    state = event(state, run(state, id, 'work', digest(incumbent), { ...metrics, interventions: 1 }));
  }
  return event(state, {
    type: 'propose',
    id: 'proposal-1',
    candidate,
    weakness: 'Checks happen after handoff and need intervention.',
    hypothesis: 'Checking earlier avoids intervention.',
    mutation: 'Move verification before handoff.',
    evidenceRunIds: ['observed-a', 'observed-b'],
  });
}
function run(
  state: Experiment,
  id: string,
  purpose: 'work' | 'benchmark',
  methodId: string,
  measured: RunRecord['metrics'] = metrics,
) {
  const method = methodId === digest(candidate) ? candidate : incumbent;
  return {
    type: 'run',
    id,
    purpose,
    taskId: purpose === 'work' ? id : id.split('-')[0],
    inputDigest: digest(purpose === 'work' ? id : id.split('-')[0]),
    methodId,
    loadedMethod: method,
    harnessRevision: 'efeda93af2ca1b94f09ae8758b0e45dd1a9d1f74',
    conditionsId: digest(criteria.conditions),
    actor: { role: 'main', sessionId: id },
    metrics: measured,
    evidence,
  };
}
function prepareComparison(state: Experiment, count = 3, candidateMetrics: RunRecord['metrics'] = metrics) {
  const pairs = criteria.tasks.slice(0, count).map(({ id }) => {
    state = event(state, run(state, `${id}-base`, 'benchmark', digest(incumbent), { ...metrics, interventions: 1 }));
    state = event(state, run(state, `${id}-candidate`, 'benchmark', digest(candidate), candidateMetrics));
    return {
      incumbentRunId: `${id}-base`,
      candidateRunId: `${id}-candidate`,
      evidence,
      checks: criteria.checks.map((id) => ({ id, incumbent: 'pass' as const, candidate: candidateMetrics.outcome })),
      incumbent: { ...metrics, interventions: 1 },
      candidate: candidateMetrics,
    };
  });
  const review: Extract<ExperimentEvent, { type: 'compare' }> = {
    type: 'compare',
    id: 'review-1',
    criteriaId: digest(criteria),
    reviewer: { role: 'reviewer', sessionId: 'independent-review' },
    pairs,
  };
  return { state, review };
}
function comparison(state: Experiment, count = 3, candidateMetrics: RunRecord['metrics'] = metrics) {
  const prepared = prepareComparison(state, count, candidateMetrics);
  return event(prepared.state, prepared.review);
}

describe('workflow experiment', () => {
  it('uses locale-independent canonical key ordering for persistent identity', () => {
    expect(digest({ a: 1, B: 2 })).toBe(contentDigest('{"B":2,"a":1}'));
  });
  it('retains evidence, independently selects, and verifies accepted identity on subsequent work', () => {
    let state = comparison(setup());
    expect(state.decision?.verdict).toBe('keep');
    expect(state.activeMethodId).toBe(digest(incumbent));
    state = event(state, {
      type: 'promote',
      id: 'promotion-1',
      approval: { ref: 'approval-1', candidateId: digest(candidate), reviewId: 'review-1' },
    });
    expect(state.adoption).toBeUndefined();
    state = event(state, run(state, 'next-work', 'work', digest(candidate)));
    expect(state.adoption).toEqual({ promotionId: 'promotion-1', runId: 'next-work', methodId: digest(candidate) });
    expect(state.runs['observed-a'].evidence).toEqual(evidence);
    expect(state.proposal?.evidenceRunIds).toEqual(['observed-a', 'observed-b']);
    expect(state.review?.reviewer.sessionId).toBe('independent-review');
    state = event(state, { type: 'rollback', id: 'rollback-1', reason: 'Subsequent work regressed', evidence });
    expect(state.activeMethodId).toBe(digest(incumbent));
    expect(state.rollback?.promotionId).toBe('promotion-1');
  });

  it('keeps the incumbent on insufficient comparable evidence', () => {
    const state = comparison(setup(), 1);
    expect(state.decision?.verdict).toBe('inconclusive');
    expect(state.activeMethodId).toBe(digest(incumbent));
  });
  it('rejects regression even when other metrics improve', () => {
    const state = comparison(setup(), 3, { ...metrics, outcome: 'fail' });
    expect(state.decision?.verdict).toBe('reject');
  });
  it('does not promote without candidate-specific approval', () => {
    const state = comparison(setup());
    expect(() => event(state, { type: 'promote', id: 'p' })).toThrow();
    expect(() =>
      event(state, {
        type: 'promote',
        id: 'p',
        approval: { ref: 'yes', candidateId: digest(incumbent), reviewId: 'review-1' },
      }),
    ).toThrow();
  });
  it('does not promote inconclusive results', () => {
    const state = comparison(setup(), 1);
    expect(() =>
      event(state, {
        type: 'promote',
        id: 'p',
        approval: { ref: 'yes', candidateId: digest(candidate), reviewId: 'review-1' },
      }),
    ).toThrow();
  });
  it('rejects changed frozen criteria and too-small benchmarks', () => {
    expect(() =>
      event(null, { type: 'init', id: 'x', incumbent, criteria: { ...criteria, minimumPairs: 1 } }),
    ).toThrow();
    expect(() =>
      event(setup(), {
        type: 'compare',
        id: 'r',
        criteriaId: digest({ ...criteria, checks: [] }),
        reviewer: { role: 'reviewer', sessionId: 'r' },
        pairs: [],
      }),
    ).toThrow();
  });
  it('cannot treat repeated copies of one task as independent benchmark evidence', () => {
    expect(() =>
      event(null, {
        type: 'init',
        id: 'x',
        incumbent,
        criteria: {
          ...criteria,
          tasks: criteria.tasks.map((task) => ({ ...task, inputDigest: digest('same input') })),
        },
      }),
    ).toThrow('Duplicate benchmark input');
  });
  it('requires repeated observed weakness before creating a candidate', () => {
    const state = event(null, { type: 'init', id: 'x', incumbent, criteria });
    expect(() =>
      event(state, {
        type: 'propose',
        id: 'p',
        candidate,
        weakness: 'guess',
        hypothesis: 'guess',
        mutation: 'guess',
        evidenceRunIds: [],
      }),
    ).toThrow();
  });
  it('detects a cached or shadowed loaded body rather than claiming adoption', () => {
    let state = comparison(setup());
    state = event(state, {
      type: 'promote',
      id: 'p',
      approval: { ref: 'yes', candidateId: digest(candidate), reviewId: 'review-1' },
    });
    expect(() =>
      event(state, { ...run(state, 'next-work', 'work', digest(candidate)), loadedMethod: incumbent }),
    ).toThrow();
  });
  it('refuses a producer reviewing its own work', () => {
    const { state, review } = prepareComparison(setup());
    expect(() => event(state, { ...review, reviewer: { role: 'reviewer', sessionId: 'a-base' } })).toThrow(
      'independent',
    );
  });
  it('refuses omitted frozen checks and contradictory review measurements', () => {
    const { state, review } = prepareComparison(setup());
    expect(() =>
      event(state, { ...review, pairs: review.pairs.map((pair) => ({ ...pair, checks: pair.checks.slice(0, 1) })) }),
    ).toThrow('every frozen check');
    expect(() =>
      event(state, {
        ...review,
        pairs: review.pairs.map((pair) => ({ ...pair, candidate: { ...pair.candidate, retries: 3 } })),
      }),
    ).toThrow('contradicts recorded');
  });
  it('does not turn uncertain evidence, ties, or greater resource friction into promotion', () => {
    expect(comparison(setup(), 3, { ...metrics, outcome: 'uncertain' }).decision?.verdict).toBe('inconclusive');
    expect(comparison(setup(), 3, { ...metrics, interventions: 1 }).decision?.verdict).toBe('inconclusive');
    expect(comparison(setup(), 3, { ...metrics, retries: 1 }).decision?.verdict).toBe('reject');
  });
  it('records incomparable harness revisions as inconclusive', () => {
    const { state, review } = prepareComparison(setup());
    const changed = structuredClone(state);
    changed.runs['a-candidate'].harnessRevision = 'a'.repeat(40);
    expect(event(changed, review).decision?.verdict).toBe('inconclusive');
  });
  it('cannot record ordinary candidate work before promotion', () => {
    const state = setup();
    expect(() => event(state, run(state, 'next-work', 'work', digest(candidate)))).toThrow();
  });
  it('does not mutate existing state or allow duplicate events', () => {
    const state = setup();
    const original = JSON.stringify(state);
    comparison(state);
    expect(JSON.stringify(state)).toBe(original);
    expect(() => event(state, run(state, 'observed-a', 'work', digest(incumbent)))).toThrow();
  });
});
