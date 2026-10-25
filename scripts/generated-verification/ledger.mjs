import assert from 'node:assert/strict';
import fc from 'fast-check';
import { ToolExecutionLedger } from '../../source/services/tool-execution-ledger.ts';
import {
  projectModelRequestHistory,
  projectProviderHistory,
} from '../../source/services/conversation/conversation-state-projector.ts';

const call = (id, args) => ({ type: 'function_call', call_id: id, name: 'probe', arguments: JSON.stringify(args) });
const result = (id, output) => ({ type: 'function_call_output', call_id: id, output });
const user = (id) => ({ type: 'message', role: 'user', content: id });
const idOf = (item) => item.call_id ?? item.callId;
const isCall = (item) => item.type === 'function_call';
const isResult = (item) => item.type === 'function_call_output';
const boundedSteps = (step) => fc.array(step, { maxLength: 30 });
const nextTurn = (ledger, previous) => {
  const id = ledger.beginTurn();
  assert.match(id, /^turn-\d+$/);
  const number = Number(id.slice(5));
  assert.ok(number > previous, 'new turn collided with an existing ledger turn');
  return number;
};

// C2.5: model effect observation, not the implementation's history-building
// branches. Fresh identities exclude the separate reopened-call policy.
const settlement = fc.property(
  boundedSteps(
    fc.record({
      action: fc.constantFrom('call', 'dispatch', 'result', 'interrupt', 'reject', 'turn', 'reload'),
      slot: fc.nat({ max: 29 }),
      scoped: fc.boolean(),
      args: fc.jsonValue(),
      output: fc.string(),
    }),
  ),
  (steps) => {
    let ledger = new ToolExecutionLedger();
    const expected = new Map();
    let turn = 0;
    for (const [index, step] of steps.entries()) {
      const entries = [...expected.values()];
      const selected = entries[step.slot % (entries.length || 1)];
      if (step.action === 'turn') {
        turn = nextTurn(ledger, turn);
      } else if (step.action === 'call') {
        const id = `call-${index}`;
        ledger.recordFunctionCall(call(id, step.args));
        expected.set(id, { id, turn, args: JSON.stringify(step.args), status: 'started', dispatched: false });
      } else if (step.action === 'reload') {
        const saved = ledger.export();
        const before = structuredClone(saved);
        ledger = new ToolExecutionLedger();
        ledger.import(saved);
        assert.deepEqual(ledger.export(), before, 'import changed saved entries');
        assert.deepEqual(saved, before, 'import mutated input');
        turn = Math.max(0, ...entries.map((entry) => entry.turn));
        turn = nextTurn(ledger, turn);
      } else if (step.action === 'dispatch' && selected?.status === 'started') {
        ledger.markDispatched(selected.id);
        selected.dispatched = true;
      } else if (step.action === 'result' && selected?.status === 'started') {
        ledger.recordFunctionResult(result(selected.id, step.output));
        selected.status = 'completed';
        selected.output = step.output;
      } else if (step.action === 'interrupt' || step.action === 'reject') {
        // Approval rejection only addresses never-dispatched calls; it is not
        // a cancellation API for effects that have already begun.
        const rejectable = entries.filter((entry) => entry.status === 'started' && !entry.dispatched);
        const rejected = rejectable[step.slot % (rejectable.length || 1)];
        const targetId =
          step.action === 'reject'
            ? rejected?.id ?? 'never-issued'
            : step.scoped
            ? selected?.id ?? 'never-issued'
            : undefined;
        if (step.action === 'interrupt') ledger.settleOpenCallsOnStreamFailure('interrupted', targetId);
        else ledger.recordAbortedApproval('rejected', 'not approved', targetId);
        for (const entry of entries) {
          if (entry.status !== 'started' || (targetId !== undefined && targetId !== entry.id)) continue;
          entry.status = step.action === 'interrupt' && entry.dispatched ? 'unknown' : 'aborted';
          entry.output = step.action === 'interrupt' ? 'interrupted' : 'rejected';
        }
      }
      const actual = ledger.export();
      assert.equal(actual.length, expected.size, 'entry lost or duplicated');
      for (const entry of actual) {
        const model = expected.get(entry.callId);
        assert.ok(model, 'unexpected call identity');
        assert.equal(entry.turnId, `turn-${model.turn}`);
        assert.equal(entry.status, model.status, 'effect observation settled incorrectly');
        assert.equal(Boolean(entry.dispatchedAt), model.dispatched, 'dispatch evidence changed');
        assert.deepEqual(entry.arguments, model.args, 'arguments changed');
        if (model.status === 'unknown') {
          assert.match(entry.output, /Outcome unobserved/, 'unknown effect described as a known outcome');
        } else if (model.status !== 'started') assert.equal(entry.output, model.output, 'observed output changed');
      }
    }
  },
);

// C2.1/C2.2: independent pair membership and user anchors, never an exact
// insertion-index oracle. Transcript omissions model compact persisted turns;
// attempts can outnumber user messages without changing their ownership.
const reconciliation = fc.property(
  fc.record({
    entries: boundedSteps(
      fc.record({
        newUser: fc.boolean(),
        extraAttempts: fc.integer({ min: 0, max: 3 }),
        outcome: fc.constantFrom('completed', 'unknown', 'aborted', 'open'),
        presence: fc.constantFrom('absent', 'call', 'result', 'pair'),
        args: fc.jsonValue(),
        output: fc.string(),
      }),
    ),
    boundary: fc.constantFrom('none', 'openai', 'local', 'both'),
  }),
  ({ entries, boundary }) => {
    const ledger = new ToolExecutionLedger();
    let userCount = 1;
    ledger.setUserTurnCountSource(() => userCount);
    const history = [user('user-1')];
    const expected = new Map();
    for (const [index, entry] of entries.entries()) {
      if (entry.newUser) history.push(user(`user-${++userCount}`));
      for (let attempt = 0; attempt <= entry.extraAttempts; attempt++) ledger.beginTurn();
      const id = `call-${index}`;
      const input = call(id, entry.args);
      ledger.recordFunctionCall(input);
      let output = entry.output;
      if (entry.outcome === 'completed') ledger.recordFunctionResult(result(id, output));
      else if (entry.outcome !== 'open') {
        if (entry.outcome === 'unknown') ledger.markDispatched(id);
        ledger.settleOpenCallsOnStreamFailure('interrupted', id);
        output = ledger.export().at(-1).output;
      }
      // Open calls have no observed result. Do not fabricate a result for them.
      if (entry.presence === 'call' || entry.presence === 'pair') history.push(input);
      if (entry.outcome !== 'open' && (entry.presence === 'result' || entry.presence === 'pair')) {
        history.push(result(id, output));
      }
      if (entry.outcome !== 'open') expected.set(id, { input, output, userCount });
    }
    let lastBoundary;
    if (boundary === 'openai' || boundary === 'both') {
      lastBoundary = history.length;
      history.push({
        type: 'provider_opaque',
        provider: 'openai',
        item: { type: 'compaction', encrypted_content: 'opaque' },
      });
    }
    if (boundary === 'local' || boundary === 'both') {
      lastBoundary = history.length;
      history.push({
        type: 'message',
        role: 'assistant',
        content: 'summary',
        contextSummary: { version: 1, strategy: 'local' },
      });
    }
    if (boundary !== 'none') history.push(user('fresh-after-boundary'));
    const saved = ledger.export();
    const before = structuredClone({ history, saved });
    const projected = projectProviderHistory({ history, toolLedger: saved });
    assert.deepEqual({ history, saved }, before, 'projection mutated history or ledger');
    assert.deepEqual(
      projectProviderHistory({ history: projected.history, toolLedger: saved }).history,
      projected.history,
      'ledger projection is not idempotent',
    );
    if (boundary !== 'none') {
      assert.deepEqual(projected.history, before.history, 'old ledger history crossed replacement boundary');
      assert.deepEqual(projected.warnings, [], 'replacement boundary reported ledger injection');
      assert.deepEqual(projectModelRequestHistory(projected.history), before.history.slice(lastBoundary));
      return;
    }
    const projectedCalls = projected.history.filter(isCall);
    const projectedResults = projected.history.filter(isResult);
    assert.equal(projectedCalls.length, expected.size, 'settled call lost, duplicated or open call retained');
    assert.equal(projectedResults.length, expected.size, 'result lost or duplicated');
    assert.deepEqual(
      projected.history.filter((item) => item.role === 'user'),
      before.history.filter((item) => item.role === 'user'),
    );
    for (const [id, model] of expected) {
      const calls = projected.history.filter((item) => isCall(item) && idOf(item) === id);
      const results = projected.history.filter((item) => isResult(item) && idOf(item) === id);
      assert.equal(calls.length, 1, 'call membership changed');
      assert.equal(results.length, 1, 'result membership changed');
      // Application-owned admission metadata is not part of the provider payload.
      const { turnId, occurrence, ...payload } = calls[0];
      assert.equal(typeof turnId, 'string', 'missing admission turn');
      assert.ok(Number.isInteger(occurrence) && occurrence > 0, 'missing admission ordinal');
      assert.deepEqual(payload, model.input, 'call payload changed');
      assert.equal(results[0].output, model.output, 'result payload changed');
      const callIndex = projected.history.indexOf(calls[0]);
      const resultIndex = projected.history.indexOf(results[0]);
      assert.ok(callIndex < resultIndex, 'result precedes call');
      const ownerIndex = projected.history.findIndex((item) => item.content === `user-${model.userCount}`);
      const nextUserIndex = projected.history.findIndex((item) => item.content === `user-${model.userCount + 1}`);
      assert.ok(callIndex > ownerIndex, 'pair precedes its user turn');
      assert.ok(nextUserIndex < 0 || resultIndex < nextUserIndex, 'pair crossed into a later user turn');
    }
  },
);

export const ledgerProperties = [
  { name: 'history.ledger-settlement', property: settlement },
  { name: 'history.ledger-reconciliation', property: reconciliation },
];
