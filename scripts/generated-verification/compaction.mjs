import assert from 'node:assert/strict';
import fc from 'fast-check';
import { planLocalCompaction } from '../../source/services/agent-runtime/context-compaction/index.ts';
import { projectModelRequestHistory } from '../../source/services/conversation/conversation-state-projector.ts';

const turn = fc.record({
  user: fc.string(),
  payload: fc.string({ maxLength: 200 }),
  size: fc.constantFrom(1, 8, 128),
  parallel: fc.integer({ min: 1, max: 3 }),
  reverse: fc.boolean(),
  synthetic: fc.boolean(),
});
const historyOf = (turns) =>
  turns.flatMap((t, n) => {
    const calls = Array.from({ length: t.parallel }, (_, k) => ({
      type: 'function_call',
      call_id: `call-${n}-${k}`,
      name: 'probe',
      arguments: '{}',
    }));
    const results = calls.map((c) => ({
      type: 'function_call_result',
      call_id: c.call_id,
      output: t.payload.repeat(t.size),
    }));
    return [
      { type: 'message', role: 'user', content: `user-${n}:${t.user}` },
      ...(t.synthetic ? [{ type: 'message', role: 'user', content: '[Previous Shell Session] synthetic' }] : []),
      ...calls,
      ...(t.reverse ? results.reverse() : results),
      { type: 'message', role: 'assistant', content: `assistant-${n}` },
    ];
  });
const idOf = (x) => x.callId ?? x.call_id;
const isCall = (x) => ['function_call', 'tool_call'].includes(x.type);
const isResult = (x) => ['function_call_result', 'function_call_output', 'tool_result'].includes(x.type);
const genuineUsers = (items) =>
  items.filter(
    (x) =>
      x.type === 'message' &&
      x.role === 'user' &&
      !(typeof x.content === 'string' && x.content.startsWith('[Previous Shell Session]')),
  );

/** Check cut postconditions independently of the planner's cut-choice heuristic. */
function checkPlan(history, usableInputTokens) {
  const before = structuredClone(history);
  const projected = projectModelRequestHistory(history);
  const plan = planLocalCompaction({ history, usableInputTokens });
  assert.deepEqual(history, before, 'planner mutated history');
  if (plan.kind === 'blocked') {
    assert.ok(['single_turn_too_large', 'no_complete_cold_turn'].includes(plan.reason));
    return;
  }
  assert.equal(plan.kind, 'planned');
  const cut = plan.coldPrefix.length;
  assert.ok(cut > 0 && cut < projected.length, 'cut must have cold and hot content');
  assert.deepEqual(plan.coldPrefix, projected.slice(0, cut), 'cold prefix not a prefix');
  assert.deepEqual(
    plan.hotTail,
    [...genuineUsers(projected.slice(0, cut)), ...projected.slice(cut)],
    'partition lost or reordered content',
  );
  assert.deepEqual(genuineUsers(plan.hotTail), genuineUsers(projected), 'lost genuine user request');
  const coldCalls = plan.coldPrefix.filter(isCall).map(idOf).sort();
  assert.deepEqual(plan.coldPrefix.filter(isResult).map(idOf).sort(), coldCalls, 'cut split a pending round');
  const hotCalls = new Set();
  for (const item of plan.hotTail) {
    if (isCall(item)) hotCalls.add(idOf(item));
    if (isResult(item)) assert.ok(hotCalls.has(idOf(item)), 'orphan in hot tail');
  }
}

export const compactionProperties = [
  {
    name: 'compaction.plan-cut',
    property: fc.property(
      fc.array(turn, { minLength: 1, maxLength: 30 }),
      fc.integer({ min: 100, max: 100000 }),
      fc.boolean(),
      (turns, budget, unpaid) => {
        const history = historyOf(turns);
        if (unpaid) history.push({ type: 'function_call', call_id: 'pending', name: 'probe', arguments: '{}' });
        checkPlan(history, budget);
        // Same generated valid turns with ample room must produce a useful plan
        // when at least three user turns exist; catches an always-blocked planner.
        if (turns.length >= 3) {
          assert.equal(planLocalCompaction({ history, usableInputTokens: 10000000 }).kind, 'planned');
        }
      },
    ),
  },
  {
    name: 'compaction.unsafe-pairs',
    property: fc.property(
      fc.array(turn, { minLength: 3, maxLength: 30 }),
      fc.constantFrom('duplicate', 'orphan'),
      (turns, fault) => {
        const history = historyOf(turns);
        const call = history.find(isCall);
        history.push(
          fault === 'duplicate' ? { ...call } : { type: 'function_call_result', call_id: 'missing', output: '' },
        );
        const before = structuredClone(history);
        assert.deepEqual(planLocalCompaction({ history, usableInputTokens: 10000000 }), {
          kind: 'blocked',
          reason: 'no_complete_cold_turn',
        });
        assert.deepEqual(history, before);
      },
    ),
  },
];
