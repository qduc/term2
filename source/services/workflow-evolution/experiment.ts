import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { SkillInfo } from '../skills/skills-service.js';

const text = z.string().trim().min(1);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const actor = z.object({ role: text, sessionId: text }).strict();
const evidence = z.array(z.object({ ref: text, digest: hash }).strict()).min(1);
const method = z.object({ name: text, revision: text, source: text, body: z.string().min(1) }).strict();
const metrics = z
  .object({
    outcome: z.enum(['pass', 'fail', 'uncertain']),
    interventions: z.number().int().nonnegative(),
    retries: z.number().int().nonnegative(),
  })
  .strict();
const criteria = z
  .object({
    tasks: z.array(z.object({ id: text, inputDigest: hash }).strict()).min(3),
    checks: z.array(text).min(1),
    conditions: text,
    minimumPairs: z.number().int().min(3),
    minimumWins: z.number().int().min(2),
  })
  .strict();
const init = z.object({ type: z.literal('init'), id: text, incumbent: method, criteria }).strict();
const run = z
  .object({
    type: z.literal('run'),
    id: text,
    purpose: z.enum(['work', 'benchmark']),
    taskId: text,
    inputDigest: hash,
    methodId: hash,
    loadedMethod: method,
    harnessRevision: z.string().regex(/^[a-f0-9]{40}$/),
    conditionsId: hash,
    actor,
    metrics,
    evidence,
  })
  .strict();
const propose = z
  .object({
    type: z.literal('propose'),
    id: text,
    candidate: method,
    weakness: text,
    hypothesis: text,
    mutation: text,
    evidenceRunIds: z.array(text).min(2),
  })
  .strict();
const compare = z
  .object({
    type: z.literal('compare'),
    id: text,
    criteriaId: hash,
    reviewer: z.object({ role: z.literal('reviewer'), sessionId: text }).strict(),
    pairs: z.array(
      z
        .object({
          incumbentRunId: text,
          candidateRunId: text,
          incumbent: metrics,
          candidate: metrics,
          evidence,
          checks: z
            .array(
              z
                .object({
                  id: text,
                  incumbent: z.enum(['pass', 'fail', 'uncertain']),
                  candidate: z.enum(['pass', 'fail', 'uncertain']),
                })
                .strict(),
            )
            .min(1),
        })
        .strict(),
    ),
  })
  .strict();
const promote = z
  .object({
    type: z.literal('promote'),
    id: text,
    approval: z.object({ ref: text, candidateId: hash, reviewId: text }).strict(),
  })
  .strict();
const rollback = z.object({ type: z.literal('rollback'), id: text, reason: text, evidence }).strict();
export const eventSchema = z.discriminatedUnion('type', [init, run, propose, compare, promote, rollback]);
export type ExperimentEvent = z.infer<typeof eventSchema>;
export type Method = z.infer<typeof method>;
export type RunRecord = z.infer<typeof run>;

/** Capture the cached/resolved body, not a later read of its file on disk. */
export function snapshotLoadedSkill(skill: Pick<SkillInfo, 'name' | 'location' | 'body'>, revision: string): Method {
  return method.parse({ name: skill.name, source: skill.location, body: skill.body, revision });
}
export interface Experiment {
  id: string;
  criteria: z.infer<typeof criteria>;
  criteriaId: string;
  incumbent: Method;
  incumbentId: string;
  activeMethodId: string;
  runs: Record<string, RunRecord>;
  proposal?: z.infer<typeof propose>;
  candidateId?: string;
  review?: z.infer<typeof compare>;
  decision?: { verdict: 'keep' | 'reject' | 'inconclusive'; reason: string };
  promotion?: z.infer<typeof promote>;
  adoption?: { promotionId: string; runId: string; methodId: string };
  rollback?: z.infer<typeof rollback> & { promotionId: string };
  eventIds: string[];
}

/** Canonical JSON identity; body whitespace remains significant. */
export function digest(value: unknown): string {
  const canonical = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonical);
    if (item !== null && typeof item === 'object') {
      return Object.fromEntries(
        Object.entries(item)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, v]) => [k, canonical(v)]),
      );
    }
    return item;
  };
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}

/** Evidence files use their actual bytes, unlike canonical JSON method identities. */
export function contentDigest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** Single-experiment reducer. No providers, tool authority, skill writes or retries. */
export function applyEvent(previous: Experiment | null, input: unknown): Experiment {
  const event = eventSchema.parse(input);
  if (event.type === 'init') {
    requireCondition(!previous, 'Experiment already initialized');
    const taskIds = event.criteria.tasks.map((t) => t.id);
    requireCondition(new Set(taskIds).size === taskIds.length, 'Duplicate benchmark task');
    requireCondition(
      new Set(event.criteria.tasks.map((t) => t.inputDigest)).size === taskIds.length,
      'Duplicate benchmark input',
    );
    requireCondition(new Set(event.criteria.checks).size === event.criteria.checks.length, 'Duplicate check');
    requireCondition(
      event.criteria.minimumPairs <= taskIds.length && event.criteria.minimumWins <= taskIds.length,
      'Criteria exceed benchmark size',
    );
    const incumbentId = digest(event.incumbent);
    return {
      id: event.id,
      criteria: event.criteria,
      criteriaId: digest(event.criteria),
      incumbent: event.incumbent,
      incumbentId,
      activeMethodId: incumbentId,
      runs: {},
      eventIds: [event.id],
    };
  }
  requireCondition(previous, 'Initialize an experiment first');
  requireCondition(!previous.eventIds.includes(event.id), 'Duplicate event id');
  const state = structuredClone(previous);
  switch (event.type) {
    case 'run': {
      const loaded =
        event.methodId === state.incumbentId
          ? state.incumbent
          : event.methodId === state.candidateId
          ? state.proposal?.candidate
          : undefined;
      requireCondition(loaded && digest(event.loadedMethod) === event.methodId, 'Loaded method identity mismatch');
      requireCondition(event.conditionsId === digest(state.criteria.conditions), 'Conditions changed');
      requireCondition(event.actor.role !== 'reviewer', 'Reviewer cannot produce task evidence');
      if (event.purpose === 'work') {
        requireCondition(event.methodId === state.activeMethodId, 'Ordinary work must use the active method');
      } else {
        requireCondition(!state.review, 'Comparison already frozen');
        const task = state.criteria.tasks.find((t) => t.id === event.taskId);
        requireCondition(task && task.inputDigest === event.inputDigest, 'Benchmark input changed');
      }
      requireCondition(!Object.hasOwn(state.runs, event.id), 'Duplicate run');
      // defineProperty avoids treating user-provided identifiers as prototype setters.
      Object.defineProperty(state.runs, event.id, {
        value: event,
        enumerable: true,
        writable: true,
        configurable: true,
      });
      if (event.purpose === 'work' && state.promotion && !state.rollback && !state.adoption) {
        state.adoption = { promotionId: state.promotion.id, runId: event.id, methodId: event.methodId };
      }
      break;
    }
    case 'propose': {
      requireCondition(!state.proposal, 'One candidate per experiment');
      const observations = event.evidenceRunIds.map((id) =>
        Object.hasOwn(state.runs, id) ? state.runs[id] : undefined,
      );
      requireCondition(
        observations.every((r) => r?.purpose === 'work' && r.methodId === state.incumbentId),
        'Proposal needs incumbent work evidence',
      );
      const weak = observations.filter(
        (r) => r && (r.metrics.outcome !== 'pass' || r.metrics.interventions > 0 || r.metrics.retries > 0),
      );
      requireCondition(new Set(weak.map((r) => r!.inputDigest)).size >= 2, 'Insufficient repeated weakness evidence');
      state.candidateId = digest(event.candidate);
      requireCondition(
        event.candidate.name === state.incumbent.name &&
          event.candidate.revision !== state.incumbent.revision &&
          event.candidate.body !== state.incumbent.body,
        'Candidate must be a new version of the incumbent method',
      );
      state.proposal = event;
      break;
    }
    case 'compare': {
      requireCondition(state.proposal && !state.review, 'Propose once before comparing once');
      requireCondition(event.criteriaId === state.criteriaId, 'Frozen evaluation criteria changed');
      const producerSessions = new Set(Object.values(state.runs).map((r) => r.actor.sessionId));
      requireCondition(!producerSessions.has(event.reviewer.sessionId), 'Reviewer must be independent of producers');
      const tasks = new Set<string>();
      let regression = false,
        uncertain = false,
        wins = 0;
      for (const pair of event.pairs) {
        const base = Object.hasOwn(state.runs, pair.incumbentRunId) ? state.runs[pair.incumbentRunId] : undefined;
        const next = Object.hasOwn(state.runs, pair.candidateRunId) ? state.runs[pair.candidateRunId] : undefined;
        requireCondition(
          base && next && base.purpose === 'benchmark' && next.purpose === 'benchmark',
          'Missing benchmark runs',
        );
        requireCondition(
          base.methodId === state.incumbentId && next.methodId === state.candidateId && base.taskId === next.taskId,
          'Invalid paired identities',
        );
        requireCondition(!tasks.has(base.taskId), 'Duplicate comparison task');
        tasks.add(base.taskId);
        requireCondition(
          pair.checks.length === state.criteria.checks.length &&
            new Set(pair.checks.map((c) => c.id)).size === pair.checks.length &&
            pair.checks.every((c) => state.criteria.checks.includes(c.id)),
          'Review must cover every frozen check',
        );
        const aggregate = (side: 'incumbent' | 'candidate') =>
          pair.checks.some((c) => c[side] === 'fail')
            ? 'fail'
            : pair.checks.some((c) => c[side] === 'uncertain')
            ? 'uncertain'
            : 'pass';
        requireCondition(
          pair.incumbent.outcome === aggregate('incumbent') && pair.candidate.outcome === aggregate('candidate'),
          'Outcome contradicts frozen check results',
        );
        // Reviewer measurements must corroborate the recorded task outcomes.
        requireCondition(
          digest(base.metrics) === digest(pair.incumbent) && digest(next.metrics) === digest(pair.candidate),
          'Review contradicts recorded measurements; correct evidence in a new experiment',
        );
        if (base.harnessRevision !== next.harnessRevision) uncertain = true;
        if (pair.incumbent.outcome === 'uncertain' || pair.candidate.outcome === 'uncertain') uncertain = true;
        if (
          pair.candidate.outcome === 'fail' ||
          pair.candidate.interventions > pair.incumbent.interventions ||
          pair.candidate.retries > pair.incumbent.retries
        )
          regression = true;
        if (
          pair.candidate.outcome === 'pass' &&
          (pair.incumbent.outcome === 'fail' ||
            pair.candidate.interventions < pair.incumbent.interventions ||
            pair.candidate.retries < pair.incumbent.retries)
        )
          wins++;
      }
      const complete = tasks.size === state.criteria.tasks.length && tasks.size >= state.criteria.minimumPairs;
      state.review = event;
      state.decision = regression
        ? { verdict: 'reject', reason: 'Candidate regression observed' }
        : !complete || uncertain
        ? { verdict: 'inconclusive', reason: 'Insufficient complete comparable evidence' }
        : wins >= state.criteria.minimumWins
        ? { verdict: 'keep', reason: `${wins} independent paired task wins without regression` }
        : { verdict: 'inconclusive', reason: 'No repeated meaningful improvement' };
      break;
    }
    case 'promote': {
      requireCondition(
        state.decision?.verdict === 'keep' && state.review && !state.promotion,
        'Only an unpromoted keep decision can be promoted',
      );
      requireCondition(
        event.approval.candidateId === state.candidateId && event.approval.reviewId === state.review.id,
        'Approval must name this candidate and review',
      );
      state.promotion = event;
      state.activeMethodId = state.candidateId!;
      break;
    }
    case 'rollback': {
      requireCondition(state.promotion && !state.rollback, 'No active promotion to roll back');
      state.rollback = { ...event, promotionId: state.promotion.id };
      state.activeMethodId = state.incumbentId;
      break;
    }
  }
  state.eventIds.push(event.id);
  return state;
}
