import process from 'node:process';
import console from 'node:console';
/* global structuredClone */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const root = process.env.SOURCE_ROOT;
const load = (p) => import(pathToFileURL(path.join(root, p)).href);
const { ConversationRecord } = await load('source/services/conversation/conversation-record.ts');
const { ToolCallExecution } = await load('source/services/agent-runtime/tool-call-execution.ts');
const { ApprovalLedger } = await load('source/services/agent-runtime/tool-invocation-context.ts');
const { HarnessInvariantError } = await load('source/lib/harness-invariant-error.ts');
const { createConversationLogWriter } = await load('source/services/logging/conversation-log-writer.ts');
const { readConversationLogEnvelopes, setConversationsDirForTest } = await load(
  'source/services/conversation/conversation-persistence.ts',
);
const { replayEvents } = await load('source/services/conversation/conversation-replay.ts');
const { resolveEnvelopeIdentities, decodeLogEnvelope } = await load(
  'source/services/conversation/conversation-decoder.ts',
);
const { normalizeRunItems } = await load('source/services/conversation/run-item-normalizer.ts');
const { InputSurgeGuard } = await load('source/services/input-surge-guard.ts');
const { createAgentStream } = await load('source/services/agent-stream.ts');
const dir = fs.mkdtempSync(path.join(process.env.OCCURRENCE_EVIDENCE_DIR, 'controls-'));
const logger = { warn() {}, info() {}, debug() {}, error() {}, getCorrelationId: () => undefined };
const call = (id = 'same', args = '{}', name = 'fake') => ({ type: 'tool_call', id, name, arguments: args });
const untag = (value) => {
  const copy = { ...value };
  delete copy.turnId;
  delete copy.occurrence;
  return copy;
};
const calls = (items) => normalizeRunItems(items).filter((item) => item.type === 'tool_call');
const results = (items) => normalizeRunItems(items).filter((x) => x.type === 'tool_result');
const observations = [];
async function setup(name, source = 'startStream') {
  const record = new ConversationRecord();
  record.beginTurn();
  record.acceptInput(name);
  record.beginAttempt();
  if (source !== 'startStream') record.beginDecisionResolution(source);
  const writer = createConversationLogWriter({ sessionId: name, dir, logger, saveLast: () => {} });
  writer.init({ id: name, createdAt: '2026-10-25T00:00:00.000Z', projectPath: dir });
  const events = [],
    bodies = [],
    starts = [],
    outputs = [];
  record.setJournalSink((event) => {
    events.push(structuredClone(event));
    writer.append(event);
  });
  const tool = {
    name: 'fake',
    parameters: { type: 'object', properties: {} },
    effect: 'read',
    parallelSafe: false,
    needsApproval: async () => false,
    execute: async (p, c, d) => {
      bodies.push(d.toolCall.callId);
      return `ok-${bodies.length}`;
    },
  };
  const context = {
    tools: [tool],
    approvals: new ApprovalLedger(),
    toolContext: { context: {} },
    onCall: (e) =>
      record.acceptObservedItem({ type: 'function_call', call_id: e.id, name: e.name, arguments: e.arguments }),
    onDispatch() {},
    onExecutionStarted: (id) => {
      starts.push(id);
      record.markDispatched(id);
    },
    onToolStall() {},
    onResult: (entry, output) => {
      outputs.push(output);
      record.acceptObservedItem({
        type: 'function_call_output',
        call_id: entry.event.id,
        output: typeof output === 'string' ? output : JSON.stringify(output),
      });
    },
  };
  const read = async () => {
    await writer.flush();
    setConversationsDirForTest(dir);
    const env = readConversationLogEnvelopes(name);
    assert(env);
    return { env, state: replayEvents(env) };
  };
  return { record, writer, events, bodies, starts, outputs, tool, context, read };
}
async function execute(h, events = [call()]) {
  const ex = new ToolCallExecution({});
  await ex.plan(events, h.context);
  await ex.settle(h.context);
  return ex;
}
async function control(name, body) {
  const h = await setup(name);
  try {
    await body(h);
    const r = await h.read();
    observations.push({
      name,
      bodies: h.bodies,
      starts: h.starts,
      events: h.events,
      live: h.record.exportToolEvidence(),
      replay: r.state,
    });
    console.log('PASS ' + name);
  } finally {
    await h.writer.close();
  }
}
for (const reused of [false, true])
  await control('no-body-approval-' + reused, async (h) => {
    const ex = new ToolCallExecution({});
    h.tool.needsApproval = async () => true;
    h.tool.parseModelArguments = JSON.parse;
    await ex.plan([call(reused ? 'same' : 'invalid', '{')], h.context);
    await ex.settle(h.context);
    assert.equal(h.bodies.length, 0);
    assert.equal(h.starts.length, 0);
    await ex.plan([call(reused ? 'same' : 'denied', '{"token":"new-work"}')], h.context);
    const old = ex.pendingApprovals[0].interruption;
    ex.resolveApproval(
      { callId: reused ? 'same' : 'denied', interruption: old },
      'rejected',
      'denied fixture',
      h.context.approvals,
    );
    await ex.settle(h.context);
    assert.equal(h.bodies.length, 0);
    assert.equal(h.starts.length, 0);
    await ex.plan([call(reused ? 'same' : 'approved', '{"token":"new-work"}')], h.context);
    assert.equal(ex.pendingApprovals.length, 1);
    const current = ex.pendingApprovals[0].interruption;
    assert.throws(
      () =>
        ex.resolveApproval(
          { callId: reused ? 'same' : 'approved', interruption: old },
          'approved',
          undefined,
          h.context.approvals,
        ),
      /stale or copied/,
    );
    assert.throws(
      () =>
        ex.resolveApproval(
          { callId: reused ? 'same' : 'approved', interruption: { ...current } },
          'approved',
          undefined,
          h.context.approvals,
        ),
      /stale or copied/,
    );
    ex.resolveApproval(
      { callId: reused ? 'same' : 'approved', interruption: current },
      'approved',
      undefined,
      h.context.approvals,
    );
    await ex.settle(h.context);
    assert.equal(h.bodies.length, 1);
    assert.equal(h.starts.length, 1);
    const { state } = await h.read();
    assert.equal(state.toolLedger.length, 3);
    assert.equal(h.record.exportToolEvidence().length, 3);
    assert.match(state.toolLedger[0].output, /Invalid/);
    assert.equal(state.toolLedger[1].output, 'denied fixture');
    assert.equal(state.toolLedger[2].output, 'ok-1');
    assert.equal(results(state.history).length, 3);
    assert.deepEqual(
      state.toolLedger.map((x) => x.occurrence),
      reused ? [1, 2, 3] : [1, 1, 1],
    );
  });
await control('unknown-tool-no-body', async (h) => {
  await execute(h, [call('same', '{}', 'missing')]);
  await execute(h);
  const { state } = await h.read();
  assert.equal(h.bodies.length, 1);
  assert.equal(state.toolLedger.length, 2);
  assert.equal(state.toolLedger[0].output, 'Unknown tool: missing');
  assert.equal(state.toolLedger[1].output, 'ok-1');
});
await control('admitted-before-result', async (h) => {
  await execute(h);
  const ex = new ToolCallExecution({});
  await ex.plan([call()], h.context);
  const { state } = await h.read();
  assert.equal(h.bodies.length, 1);
  assert.equal(h.starts.length, 1);
  assert.equal(state.toolLedger.length, 2);
  assert.equal(state.toolLedger[0].status, 'completed');
  assert.equal(state.toolLedger[0].output, 'ok-1');
  assert.equal(state.toolLedger[1].status, 'unknown');
  assert.equal(results(state.toolLedger[0].historyItems)[0].output, 'ok-1');
  assert.match(results(state.toolLedger[1].historyItems)[0].output, /Outcome unobserved/);
  assert.deepEqual(
    state.toolLedger.map((x) => x.occurrence),
    [1, 2],
  );
});
await control('direct-segment', async (h) => {
  await execute(h);
  h.record.beginDecisionResolution();
  await execute(h);
  const direct = h.events.filter((x) => x.type === 'tool_result');
  assert.equal(direct.length, 1);
  assert.deepEqual(
    direct.map((x) => [x.turnId, x.occurrence, x.output]),
    [['turn-1', 2, 'ok-2']],
  );
  assert.equal(results(direct[0].historyItems)[0].output, 'ok-2');
  const { state } = await h.read();
  assert.equal(state.toolLedger.length, 2);
  assert.deepEqual(
    state.toolLedger.map((x) => x.output),
    ['ok-1', 'ok-2'],
  );
  // Continuation finals may offer only their result suffix, without a rich snapshot.
  const { env } = await h.read();
  const finalResult = h.record
    .getCurrentTurnItems()
    .filter((item) => item.type === 'tool_result')
    .at(-1);
  const compact = { ...finalResult };
  delete compact.turnId;
  delete compact.occurrence;
  const resumedFinal = replayEvents([
    ...env,
    {
      v: 1,
      seq: 999,
      ts: '2026-10-25T00:00:01.000Z',
      event: {
        type: 'assistant_turn',
        turnId: 'turn-1',
        turn: { items: [compact, { type: 'assistant_text', text: 'after tools' }] },
        state: { previousResponseId: null },
      },
    },
  ]);
  assert.deepEqual(
    resumedFinal.toolLedger.map((entry) => entry.output),
    ['ok-1', 'ok-2'],
  );
  assert.deepEqual(
    results(resumedFinal.history).map((item) => item.output),
    ['ok-1', 'ok-2'],
  );
  assert.equal(calls(resumedFinal.history).length, 2);
  assert.equal(normalizeRunItems(resumedFinal.history).at(-1).text, 'after tools');
});
await control('same-occurrence-and-accumulated-segments', async (h) => {
  h.record.recordReasoningDelta('reason owned by first admission');
  h.record.acceptObservedItem({
    type: 'reasoning',
    text: 'reason owned by first admission',
    providerItemId: 'reason-1',
    providerMetadata: { signature: 'retained' },
  });
  const canonical = { type: 'tool_call', callId: 'same', toolName: 'fake', arguments: '{}' };
  h.record.acceptObservedItem(canonical);
  // A raw wrapper and canonical form of the same admitted (still open) call.
  h.record.acceptObservedItem({ rawItem: { type: 'function_call', call_id: 'same', name: 'fake', arguments: '{}' } });
  // The real approval owner re-offers UI arguments (e.g. 'true'), not JSON.
  h.record.recordFunctionCall({ type: 'function_call', callId: 'same', name: 'fake', arguments: 'display-only' });
  assert.equal(h.record.exportToolEvidence()[0].arguments, '{}');
  h.record.acceptObservedItem({ type: 'function_call_output', call_id: 'same', output: 'equal' });
  const first = h.record.getCurrentTurnItems();
  const result = first.find((x) => x.type === 'tool_result');
  h.record.acceptObservedItem(result);
  h.record.acceptObservedItem(first.find((x) => x.type === 'tool_call'));
  assert.equal(h.events.filter((x) => x.item?.type === 'tool_call').length, 1);
  assert.equal(h.events.filter((x) => x.item?.type === 'tool_result').length, 1);
  // Truly new byte-identical call and output must not be treated as wrappers.
  h.record.acceptObservedItem({ type: 'function_call', call_id: 'same', name: 'fake', arguments: '{}' });
  h.record.acceptObservedItem({ type: 'function_call_output', call_id: 'same', output: 'equal' });
  assert.equal(h.record.exportToolEvidence().length, 2);
  const { state } = await h.read();
  assert.equal(state.toolLedger.length, 2);
  assert.equal(normalizeRunItems(state.toolLedger[0].historyItems).filter((x) => x.type === 'reasoning').length, 1);
  assert.equal(normalizeRunItems(state.toolLedger[1].historyItems).filter((x) => x.type === 'reasoning').length, 0);
  // Re-offer complete untagged accumulated snapshots at successive segment boundaries.
  const history = h.record
    .getReconciledHistory()
    .filter((x) => normalizeRunItems([x]).some((y) => y.type === 'tool_call' || y.type === 'tool_result'))
    .map(untag);
  const initial = h.record.getReconciledHistory().length;
  for (let i = 0; i < 5; i++) {
    h.record.beginDecisionResolution();
    h.record.beginSegment();
    const stream = createAgentStream({
      async *[Symbol.asyncIterator]() {},
      completed: Promise.resolve(),
      history: [],
      newItems: history,
      output: history,
      interruptions: [],
    });
    h.record.acceptSegment(stream, 'delta', { logger, sessionId: 'segments' });
    assert.equal(h.record.getReconciledHistory().length, initial, 'accumulated segment growth');
  }
  const snapshot = h.record.snapshot({ previousResponseId: null });
  const imported = new ConversationRecord();
  imported.importState(snapshot);
  assert.equal(imported.exportToolEvidence().length, 2);
  assert.deepEqual(
    imported.exportToolEvidence().map((x) => x.occurrence),
    [1, 2],
  );
});
for (const kind of ['ordinary', 'invariant'])
  await control('parallel-' + kind, async (h) => {
    await execute(h);
    h.record.beginAttempt();
    h.tool.parallelSafe = true;
    h.tool.execute = async (p, c, d) => {
      h.bodies.push(d.toolCall.callId);
      if (d.toolCall.callId === 'bad') {
        if (kind === 'invariant') throw new HarnessInvariantError('rejecting sibling fixture');
        throw new Error('ordinary fixture');
      }
      return 'fulfilled sibling';
    };
    let error;
    try {
      await execute(h, [call('bad'), call('same')]);
    } catch (e) {
      error = e;
    }
    assert.equal(h.bodies.length, 3);
    assert.equal(h.outputs.at(-1), 'fulfilled sibling');
    if (kind === 'invariant') assert.equal(error?.name, 'HarnessInvariantError');
    else assert.equal(error, undefined);
    h.record.recover(
      { kind: 'retry_fresh', inputMode: 'full_history' },
      { baseline: 'initial', addedUserMessage: false, stream: {} },
    );
    const live = h.record.exportToolEvidence();
    assert.equal(live.length, 3);
    assert.deepEqual(
      live.filter((x) => x.callId === 'same').map((x) => x.output),
      ['ok-1', 'fulfilled sibling'],
    );
    const { state } = await h.read();
    assert.equal(state.toolLedger.length, 3);
    const bad = state.toolLedger.find((entry) => entry.callId === 'bad');
    if (kind === 'ordinary') {
      assert.equal(bad.status, 'completed');
      assert.match(bad.output, /ordinary fixture/);
    } else {
      assert.equal(bad.status, 'unknown');
      assert.match(results(bad.historyItems)[0].output, /Outcome unobserved/);
    }
    assert.deepEqual(
      state.toolLedger.filter((x) => x.callId === 'same').map((x) => x.output),
      ['ok-1', 'fulfilled sibling'],
    );
  });
await control('final-legacy-rich-envelope-controls', async (h) => {
  await execute(h);
  await execute(h);
  const current = h.record.getCurrentTurnItems();
  const { env } = await h.read();
  const stamp = '2026-10-25T01:00:00.000Z';
  const final = (items) => ({
    v: 1,
    ts: stamp,
    seq: 999,
    logId: 'controls',
    eventId: 'final',
    event: { type: 'assistant_turn', turnId: 'turn-1', turn: { items }, state: { previousResponseId: null } },
  });
  const explicit = replayEvents([...env, final(current)]);
  assert.equal(explicit.toolLedger.length, 2);
  assert.equal(results(explicit.history).length, 2);
  const untagged = current.map(untag);
  const legacyEnv = env.map((e) => ({
    ...e,
    event: e.event.type === 'assistant_journal_item' ? { ...e.event, item: untag(e.event.item) } : e.event,
  }));
  const fallback = replayEvents([...legacyEnv, final(untagged)]);
  assert.equal(fallback.toolLedger.length, 2);
  assert.equal(results(fallback.history).length, 2);
  const snapshot = h.record.snapshot({ previousResponseId: null });
  snapshot.toolLedger[0].failureReason = 'rich snapshot evidence';
  snapshot.history = snapshot.history.map(untag);
  snapshot.toolLedger.forEach((e) => {
    delete e.occurrence;
    e.historyItems = e.historyItems.map(untag);
  });
  const rich = final(untagged);
  rich.event.snapshot = snapshot;
  const richReplay = replayEvents([...env, rich]);
  assert.equal(richReplay.toolLedger.length, 2);
  assert.equal(richReplay.toolLedger[0].failureReason, 'rich snapshot evidence');
  const imported = new ConversationRecord();
  imported.importState(snapshot);
  assert.equal(imported.exportToolEvidence().length, 2);
  assert.deepEqual(
    imported.exportToolEvidence().map((x) => x.occurrence),
    [1, 2],
  );
  assert.equal(results(imported.getReconciledHistory()).length, 2);
  // Envelope identity is separate from occurrence identity.
  const duplicate = resolveEnvelopeIdentities([...env, ...env], 'controls');
  assert.equal(duplicate.length, env.length);
  assert.equal(replayEvents(duplicate).toolLedger.length, 2);
  // Same occurrence duplicated in an authoritative final is repaired, not enlarged.
  const duplicated = replayEvents([final([...current, ...current])]);
  assert.equal(duplicated.toolLedger.length, 2);
  assert.equal(results(duplicated.history).length, 2);
  const next = final(
    current.map((item) =>
      item.type === 'tool_call' || item.type === 'tool_result' ? { ...item, turnId: 'turn-2' } : item,
    ),
  );
  next.eventId = 'turn2';
  next.event.turnId = 'turn-2';
  const twoTurns = replayEvents([final(current), next]);
  assert.equal(twoTurns.toolLedger.length, 4);
  assert.equal(results(twoTurns.history).length, 4);
  // Missing old bytes stay missing; display-only legacy evidence remains best effort.
  const bare = replayEvents([
    { v: 1, ts: stamp, event: { type: 'tool_started', toolCallId: 'legacy', toolName: 'fake' } },
  ]);
  assert.equal(bare.toolLedger.length, 1);
  assert.equal(bare.toolLedger[0].status, 'unknown');
  assert.equal(replayEvents([]).toolLedger.length, 0);
  assert.equal(
    decodeLogEnvelope({
      ...final(current),
      event: {
        type: 'assistant_journal_item',
        turnId: 'turn-1',
        seq: 1,
        item: { ...current.find((x) => x.type === 'tool_call'), occurrence: 0 },
      },
    }),
    null,
  );
  assert.throws(() =>
    imported.importState({ ...snapshot, toolLedger: [{ ...snapshot.toolLedger[0], occurrence: 0 }] }),
  );
  assert.equal(
    decodeLogEnvelope({
      ...rich,
      event: { ...rich.event, snapshot: { ...snapshot, toolLedger: [{ ...snapshot.toolLedger[0], occurrence: 0 }] } },
    }),
    null,
  );
});
// The guard must still block three repeated representations of known pairs,
// and retain its legacy untagged heuristic. The real six-call next-request
// acceptance is in full-turn.mjs, not manufactured here.
const guard = new InputSurgeGuard();
const pairs = Array.from({ length: 3 }, (_, i) => [
  { type: 'tool_call', callId: `id-${i}`, toolName: 'fake', arguments: '{}', turnId: 'turn-1', occurrence: 1 },
  {
    type: 'tool_result',
    callId: `id-${i}`,
    toolName: 'fake',
    output: 'ok',
    status: 'completed',
    turnId: 'turn-1',
    occurrence: 1,
  },
]).flat();
assert.equal(guard.inspect([...pairs, ...pairs]).action, 'block');
assert.equal(guard.inspect([...pairs, ...pairs].map(untag)).action, 'block');
console.log('PASS guard duplicate controls');
fs.writeFileSync(path.join(dir, 'observations.json'), JSON.stringify(observations, null, 2));
console.log('Control evidence: ' + dir);
