import process from 'node:process';
import console from 'node:console';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const root = process.env.SOURCE_ROOT,
  load = (p) => import(pathToFileURL(path.join(root, p)));
const { replayEvents } = await load('source/services/conversation/conversation-replay.ts');
const { decodeLogEnvelope } = await load('source/services/conversation/conversation-decoder.ts');
const { createSessionRuntimeInternals, buildSessionRuntime } = await load(
  'source/services/session/session-composition.ts',
);
const { ToolOwnershipRegistry } = await load('source/services/approval/tool-ownership-registry.ts');
const { ApplicationRunLoop } = await load('source/services/agent-runtime/application-run-loop.ts');
const tagged = process.env.TAGGED === '1',
  different = process.env.DIFFERENT === '1';
const events = [];
for (let n = 1; n <= 2; n++) {
  const wrap = (event) => ({ v: 1, ts: `2026-10-25T00:00:0${events.length}Z`, seq: events.length + 1, event });
  events.push(wrap({ type: 'user_message', message: { id: `user-${n}`, sender: 'user', text: `question ${n}` } }));
  const meta = tagged ? { turnId: `turn-${n}`, occurrence: 1 } : {};
  events.push(
    wrap({
      type: 'assistant_turn',
      turnId: `turn-${n}`,
      turn: {
        items: [
          { type: 'tool_call', callId: 'same', toolName: 'fake', arguments: '{}', ...meta },
          {
            type: 'tool_result',
            callId: 'same',
            toolName: 'fake',
            status: 'completed',
            output: different ? `result-${n}` : 'equal',
            ...meta,
          },
        ],
      },
      state: { previousResponseId: null },
    }),
  );
}
assert(
  events.every((e) => decodeLogEnvelope(e)),
  'supported valid envelopes',
);
const state = replayEvents(events),
  requests = [];
const loop = new ApplicationRunLoop({
  resolveModel: () => ({
    async *stream(r) {
      requests.push(JSON.parse(JSON.stringify(r)));
      yield { type: 'completion', responseId: 'done', output: [] };
    },
  }),
});
const client = {
  getProvider: () => 'openai',
  getModel: () => 'fixture',
  abort() {
    loop.abort();
  },
  addToolInterceptor: () => () => {},
  async runTurn(s) {
    await loop.runTurn({
      ...s,
      async prepare(signal) {
        const p = await s.prepare(signal);
        return p
          ? {
              ...p,
              agent: { name: 'offline', model: 'fixture', instructions: 'offline', tools: [] },
              options: { ...p.options, maxTurns: 1, providerId: 'openai' },
            }
          : undefined;
      },
    });
  },
};
const logger = { getCorrelationId: () => undefined, warn() {}, debug() {}, info() {}, error() {} };
const fresh = createSessionRuntimeInternals({
  sessionId: 'legacy-repro',
  agentClient: client,
  toolOwnership: new ToolOwnershipRegistry(),
  deps: { logger, sessionContextService: {} },
});
try {
  fresh.record.importState({ history: state.history, toolLedger: state.toolLedger, previousResponseId: null });
  for await (const event of buildSessionRuntime(fresh).turns.start('resume', { maxModelRetries: 0 })) {
    assert.notEqual(event.type, 'error', 'resume must reach model without recovery error');
  }
} finally {
  fresh.dispose();
}
console.log(JSON.stringify({ tagged, different, events, state, requests }, null, 2));
assert.equal(requests.length, 1);
assert.equal(requests[0].input.filter((x) => x.type === 'tool_call').length, 2, 'actual next request two calls');
assert.equal(requests[0].input.filter((x) => x.type === 'tool_result').length, 2, 'actual next request two results');

assert.deepEqual(
  requests[0].input.filter((x) => x.type === 'tool_result').map((x) => x.output),
  different ? ['result-1', 'result-2'] : ['equal', 'equal'],
  'ordered outputs remain owned by their turn',
);
assert.deepEqual(
  state.toolLedger.map((x) => [x.turnId, x.callId, x.occurrence]),
  [
    ['turn-1', 'same', 1],
    ['turn-2', 'same', 1],
  ],
  'turn-local occurrence ownership',
);
