// Integration probe: manual Session plan through the real local compactor and model stream.
import assert from 'node:assert/strict';
import { compactDirectHistory } from '../src/engine/direct-recovery-compaction.js';
import { prepareDirectManualCompaction } from '../src/session/direct-command-compaction.js';

const ref = { provider: 'codex', model: 'unknown-capacity' };
let calls = 0;
const model = {
  ref,
  async *stream() {
    calls++;
    yield { type: 'text_delta' as const, delta: 'Summary of earlier work.' };
    yield { type: 'done' as const, stopReason: 'end_turn' as const };
  },
};
const history = Array.from({ length: 3 }, (_, i) => [
  { type: 'user_message' as const, id: `u${i}`, content: [{ type: 'text' as const, text: `request ${i}` }] },
  {
    type: 'assistant_message' as const,
    id: `a${i}`,
    content: [{ type: 'text' as const, text: 'long result '.repeat(500) }],
  },
]).flat();
const request = { model: ref, instructions: 'help', input: history, tools: [] };
const input = {
  model,
  request,
  settings: { enabled: true, mode: 'local' as const, compactThreshold: 0.8, compactThresholdTokens: null },
  signal: new AbortController().signal,
};
const automatic = await compactDirectHistory({ ...input, manual: false });
assert.equal(automatic.kind, 'blocked');
assert.equal(automatic.kind === 'blocked' && automatic.reason, 'unknown_threshold');
assert.equal(calls, 0);
const plan = await prepareDirectManualCompaction({ executionsSettled: true, history, revision: 'r1' } as any, input);
assert.equal(plan.kind, 'replace');
if (plan.kind !== 'replace') throw Error('manual compaction did not replace history');
assert.equal(plan.fact.type, 'history_replaced');
assert.equal('rearmAtEstimatedTokens' in plan.fact, false);
assert.ok(calls > 0);
assert.ok(plan.result.estimate.renderedInputTokens < plan.result.before.renderedInputTokens);
const constrained = await prepareDirectManualCompaction({ executionsSettled: true, history, revision: 'r1' } as any, {
  ...input,
  maxRequestInputTokens: 1,
});
assert.equal(constrained.kind, 'not_compacted');
assert.equal(constrained.kind === 'not_compacted' && constrained.result.kind, 'blocked');
console.log(
  'PASS: manual unknown capacity replaces history; automatic remains blocked; explicit ceiling remains enforced',
);
