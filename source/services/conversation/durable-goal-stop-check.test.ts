import { describe, expect, it } from 'vitest';
import type { ProviderInputItem } from '../../contracts/provider-input.js';
import type { DurableGoal } from '../logging/conversation-log-events.js';
import {
  GOAL_CHECK_RECORDED_PREFIX,
  GOAL_CHECK_UNRESOLVED_CAUSE,
  GOAL_STOP_REMINDER_PREFIX,
  MAX_GOAL_STOP_REMINDERS_PER_TURN,
  MAX_GOAL_STOP_REMINDERS_WITHOUT_WORK,
  createGoalStopPolicy,
  decideGoalStop,
  validateGoalCheck,
} from './durable-goal-stop-check.js';

const goal: DurableGoal = { id: 'g', outcome: 'Ship the feature', status: 'active' };
const goalWithCriteria: DurableGoal = { ...goal, successCriteria: 'Focused tests pass' };

const user = (content: string): ProviderInputItem => ({ type: 'message', role: 'user', content });
const assistant = (text: string): ProviderInputItem => ({
  type: 'message',
  role: 'assistant',
  content: [{ type: 'output_text', text }],
});
let nextId = 0;
const call = (name: string, args: unknown, output: unknown = 'ok'): ProviderInputItem[] => {
  const callId = `call-${++nextId}`;
  return [
    { type: 'function_call', callId, name, arguments: JSON.stringify(args) },
    { type: 'function_call_result', callId, name, output },
  ];
};
/** A goal_check whose result is the tool's own success text, as the real tool records it. */
const check = (args: Record<string, unknown>, output = `${GOAL_CHECK_RECORDED_PREFIX} ${String(args.status)}.`) =>
  call('goal_check', args, output);
const work = () => call('read_file', { path: 'a.ts' });
/** Providers without native ids number calls per response, so every response's first call is call_0. */
const pairWithId = (callId: string, name: string, args: unknown, output: unknown): ProviderInputItem[] => [
  { type: 'function_call', callId, name, arguments: JSON.stringify(args) },
  { type: 'function_call_result', callId, name, output },
];
const recorded = (status: string) => `${GOAL_CHECK_RECORDED_PREFIX} ${status}.`;
const reminder = (): ProviderInputItem => user(`[Mode Notice] ${GOAL_STOP_REMINDER_PREFIX} (1 of 2): check.`);

describe('validateGoalCheck', () => {
  it('requires an active goal, non-empty evidence, and criteria evidence for achieved with criteria', () => {
    expect(validateGoalCheck({ status: 'achieved', evidence: 'done' }, undefined)).toMatchObject({ ok: false });
    expect(validateGoalCheck({ status: 'achieved', evidence: 'done' }, { ...goal, status: 'achieved' })).toMatchObject({
      ok: false,
    });
    expect(validateGoalCheck({ status: 'achieved', evidence: '   ' }, goal)).toMatchObject({ ok: false });
    expect(validateGoalCheck({ status: 'finished', evidence: 'done' }, goal)).toMatchObject({ ok: false });
    expect(validateGoalCheck({ status: 'achieved', evidence: 'tests pass' }, goal)).toMatchObject({ ok: true });
    expect(validateGoalCheck({ status: 'achieved', evidence: 'tests pass' }, goalWithCriteria)).toEqual({
      ok: false,
      problem: 'criteriaEvidence is required for achieved because the goal has success criteria',
    });
    expect(
      validateGoalCheck(
        { status: 'achieved', evidence: 'shipped', criteriaEvidence: 'vitest: 12 passed' },
        goalWithCriteria,
      ),
    ).toMatchObject({ ok: true });
    // Only achieved needs criteria evidence; a blocker or deferral does not.
    expect(validateGoalCheck({ status: 'blocked', evidence: 'need a token' }, goalWithCriteria)).toMatchObject({
      ok: true,
    });
  });
});

describe('decideGoalStop', () => {
  it('never engages without an active goal', () => {
    const history = [user('hi'), assistant('hello')];
    expect(decideGoalStop(undefined, history)).toEqual({ action: 'stop', reason: 'no_active_goal' });
    expect(decideGoalStop({ ...goal, status: 'achieved' }, history)).toEqual({
      action: 'stop',
      reason: 'no_active_goal',
    });
    expect(decideGoalStop({ ...goal, status: 'abandoned' }, history)).toEqual({
      action: 'stop',
      reason: 'no_active_goal',
    });
  });

  it.each(['achieved', 'blocked', 'deferred'] as const)('permits the stop after a valid %s check', (status) => {
    const history = [user('go'), ...work(), ...check({ status, evidence: 'specific evidence' }), assistant('done')];
    expect(decideGoalStop(goal, history)).toEqual({ action: 'stop', reason: status });
  });

  it('continues after a not_achieved check and names the remaining work in the reminder', () => {
    const history = [user('go'), ...check({ status: 'not_achieved', evidence: 'tests still red' }), assistant('ok')];
    const decision = decideGoalStop(goal, history);
    expect(decision).toMatchObject({ action: 'continue', reason: 'not_achieved', remindersWithoutWork: 0 });
    expect(decision.action === 'continue' && decision.reminder).toContain('tests still red');
  });

  it('does not let a missing check silently permit a stop', () => {
    const decision = decideGoalStop(goal, [user('go'), ...work(), assistant('all done')]);
    expect(decision).toMatchObject({ action: 'continue', reason: 'missing_check' });
    expect(decision.action === 'continue' && decision.reminder.startsWith(GOAL_STOP_REMINDER_PREFIX)).toBe(true);
  });

  it('treats an incomplete check as unresolved rather than as achievement', () => {
    const decision = decideGoalStop(goalWithCriteria, [
      user('go'),
      ...check({ status: 'achieved', evidence: 'looks done' }),
      assistant('done'),
    ]);
    expect(decision).toMatchObject({ action: 'continue', reason: 'incomplete_check' });
    expect(decision.action === 'continue' && decision.reminder).toContain('criteriaEvidence is required');
  });

  it('rejects a check that predates later work, a newer user message, or results it had not seen', () => {
    const achieved = { status: 'achieved', evidence: 'done' };
    expect(decideGoalStop(goal, [user('go'), ...check(achieved), ...work(), assistant('done')])).toMatchObject({
      action: 'continue',
      reason: 'missing_check',
    });
    // A newer user instruction starts a new window; the earlier check does not answer it.
    expect(decideGoalStop(goal, [user('go'), ...check(achieved), user('now do X'), assistant('did X')])).toMatchObject({
      action: 'continue',
      reason: 'missing_check',
    });
    // Same response: both calls planned before either result was seen.
    const [workCall, workResult] = work();
    const [checkCall, checkResult] = check(achieved);
    expect(
      decideGoalStop(goal, [user('go'), workCall!, checkCall!, workResult!, checkResult!, assistant('done')]),
    ).toMatchObject({ action: 'continue', reason: 'missing_check' });
  });

  it('does not treat harness notices as a newer user instruction', () => {
    const history = [
      user('go'),
      ...check({ status: 'achieved', evidence: 'done' }),
      user('[Mode Notice] Context is getting long.'),
      assistant('done'),
    ];
    expect(decideGoalStop(goal, history)).toEqual({ action: 'stop', reason: 'achieved' });
  });

  it('returns control at the reminder limit and resets the count after real work', () => {
    expect(MAX_GOAL_STOP_REMINDERS_WITHOUT_WORK).toBe(2);
    const base = [user('go'), assistant('done')];
    // threshold - 1
    expect(decideGoalStop(goal, [...base, reminder(), assistant('done')])).toMatchObject({
      action: 'continue',
      remindersWithoutWork: 1,
    });
    // threshold
    expect(decideGoalStop(goal, [...base, reminder(), assistant('done'), reminder(), assistant('done')])).toEqual({
      action: 'stop',
      reason: 'unresolved',
      terminalCause: GOAL_CHECK_UNRESOLVED_CAUSE,
      limitReached: 'without_work',
      remindersWithoutWork: 2,
      remindersThisTurn: 2,
      lastProblem: 'missing_check',
    });
    // threshold + 1 stays stopped (an idle not_achieved check is not work)
    expect(
      decideGoalStop(goal, [
        ...base,
        reminder(),
        reminder(),
        reminder(),
        ...check({ status: 'not_achieved', evidence: 'later' }),
        assistant('done'),
      ]),
    ).toMatchObject({ action: 'stop', reason: 'unresolved', lastProblem: 'not_achieved' });
    // Real work after the reminders resets the idle count.
    expect(
      decideGoalStop(goal, [...base, reminder(), assistant('x'), reminder(), ...work(), assistant('done')]),
    ).toMatchObject({ action: 'continue', remindersWithoutWork: 0, remindersThisTurn: 2 });
  });

  it('caps total reminders per user instruction even when work separates every stop', () => {
    expect(MAX_GOAL_STOP_REMINDERS_PER_TURN).toBe(6);
    const alternating = (reminders: number) => [
      user('go'),
      ...Array.from({ length: reminders }, () => [...work(), assistant('done'), reminder()]).flat(),
      ...work(),
      assistant('done'),
    ];
    // threshold - 1: the sixth reminder is still sent.
    expect(decideGoalStop(goal, alternating(5))).toMatchObject({
      action: 'continue',
      remindersWithoutWork: 0,
      remindersThisTurn: 5,
    });
    expect((decideGoalStop(goal, alternating(5)) as { reminder: string }).reminder).toContain('6 of 6 this turn');
    // threshold: work reset the idle count every time, the per-turn cap still returns control.
    expect(decideGoalStop(goal, alternating(6))).toEqual({
      action: 'stop',
      reason: 'unresolved',
      terminalCause: GOAL_CHECK_UNRESOLVED_CAUSE,
      limitReached: 'per_turn',
      remindersWithoutWork: 0,
      remindersThisTurn: 6,
      lastProblem: 'missing_check',
    });
    // A new user instruction starts a fresh allowance.
    expect(decideGoalStop(goal, [...alternating(6).slice(0, -1), user('keep going'), assistant('ok')])).toMatchObject({
      action: 'continue',
      remindersThisTurn: 0,
    });
  });

  it.each([
    ['denied by the user', 'Tool execution was not approved.'],
    ['rejected with a custom message', 'Self-check skipped: the user rejected this call.'],
    ['failed during execution', 'Error: goal source unavailable'],
    ['returned as content parts without the success text', [{ type: 'input_text', text: 'rejected' }]],
  ])('does not count a valid-looking check that was %s', (_case, output) => {
    const history = [user('go'), ...work(), ...check({ status: 'achieved', evidence: 'done' }, output as never)];
    const decision = decideGoalStop(goal, [...history, assistant('done')]);
    expect(decision).toMatchObject({ action: 'continue', reason: 'incomplete_check' });
    expect(decision.action === 'continue' && decision.reminder).toContain('was not recorded');
  });

  it('counts a recorded check whose result arrives as content parts or without a result', () => {
    const parts = [{ type: 'input_text', text: `${GOAL_CHECK_RECORDED_PREFIX} blocked. Control returns.` }];
    expect(
      decideGoalStop(goal, [user('go'), ...check({ status: 'blocked', evidence: 'need token' }, parts as never)]),
    ).toEqual({ action: 'stop', reason: 'blocked' });
    // A call with no recorded result at all never authorizes the stop.
    const [lonelyCall] = check({ status: 'achieved', evidence: 'done' });
    expect(decideGoalStop(goal, [user('go'), lonelyCall!, assistant('done')])).toMatchObject({
      action: 'continue',
      reason: 'incomplete_check',
    });
  });
});

describe('decideGoalStop with repeated provider call ids', () => {
  const achieved = { status: 'achieved', evidence: 'tests pass' };

  it('binds a check to its own result when an earlier tool call reused call_0', () => {
    const history = [
      user('ship it'),
      ...pairWithId('call_0', 'read_file', { path: 'a.ts' }, 'file contents'),
      ...pairWithId('call_0', 'goal_check', achieved, recorded('achieved')),
      assistant('Done.'),
    ];
    expect(decideGoalStop(goal, history)).toEqual({ action: 'stop', reason: 'achieved' });
  });

  it('does not let an earlier recorded check on call_0 authorize a later rejected check on call_0', () => {
    const history = [
      user('ship it'),
      ...pairWithId(
        'call_0',
        'goal_check',
        { status: 'not_achieved', evidence: 'tests red' },
        recorded('not achieved'),
      ),
      ...work(),
      ...pairWithId('call_0', 'goal_check', achieved, 'Tool execution was not approved.'),
      assistant('Done.'),
    ];
    const decision = decideGoalStop(goal, history);
    expect(decision).toMatchObject({ action: 'continue', reason: 'incomplete_check' });
    expect(decision.action === 'continue' && decision.reminder).toContain('was not recorded');
  });

  it.each([
    ['a rejected result', [{ type: 'function_call_result', callId: 'call_0', name: 'goal_check', output: 'rejected' }]],
    ['no result', []],
  ])(
    'ignores a recorded call_0 result from before the latest user message when the current check has %s',
    (_case, currentResult) => {
      const history = [
        user('first instruction'),
        ...pairWithId('call_0', 'goal_check', achieved, recorded('achieved')),
        assistant('Done.'),
        user('second instruction'),
        { type: 'function_call', callId: 'call_0', name: 'goal_check', arguments: JSON.stringify(achieved) },
        ...(currentResult as ProviderInputItem[]),
        assistant('Done again.'),
      ];
      expect(decideGoalStop(goal, history)).toMatchObject({ action: 'continue', reason: 'incomplete_check' });
    },
  );
});

describe('createGoalStopPolicy', () => {
  const tools = [{ name: 'goal_check' }] as never;

  it('is inert when the agent cannot call goal_check or no goal is active', () => {
    const history = [user('go'), assistant('done')];
    expect(createGoalStopPolicy(() => goal)(history, { tools: [] })).toEqual({ action: 'stop' });
    expect(createGoalStopPolicy(() => undefined)(history, { tools })).toEqual({ action: 'stop' });
  });

  it('reads the latest persisted goal at decision time and exposes content-free diagnostics', () => {
    let current: DurableGoal | undefined = goal;
    const policy = createGoalStopPolicy(() => current);
    const history = [user('secret prompt text'), assistant('done')];
    const decision = policy(history, { tools });
    expect(decision).toMatchObject({
      action: 'continue',
      diagnostics: {
        guard: 'goal_stop_check',
        guardClass: 'runaway',
        reason: 'missing_check',
        limit: 2,
        turnLimit: 6,
        remindersWithoutWork: 0,
        remindersThisTurn: 0,
      },
    });
    expect(JSON.stringify(decision.diagnostics)).not.toContain('secret');
    current = { ...goal, status: 'abandoned' };
    expect(policy(history, { tools })).toEqual({ action: 'stop' });
  });
});
