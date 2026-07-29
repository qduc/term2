import { expect, it } from 'vitest';
import { filterChainedModelInput } from '../lib/chained-input-filter.js';
import type { ProviderHistorySnapshot } from '../services/conversation/conversation-store.js';
import { projectOpenAIChainedModelInput } from './openai-chained-input-compatibility.js';

const snapshot = (history: unknown[]): ProviderHistorySnapshot =>
  Object.freeze({ revision: 4, identity: 'history:test:4', history: Object.freeze(history) as any });

const expectParity = (history: unknown[], modelData: any, options: any = {}) => {
  const projection = projectOpenAIChainedModelInput(snapshot(history), modelData, options);
  expect(projection.projectedModelData).toEqual(filterChainedModelInput(modelData, options));
  return projection;
};

it('anchors an exact history prefix and characterizes the current-turn suffix', () => {
  const history = [{ role: 'user', type: 'message', content: 'earlier' }];
  const suffix = { role: 'user', type: 'message', content: 'now' };
  const projection = expectParity(history, { input: [...history, suffix] });

  expect(projection.prefix).toEqual({
    kind: 'match',
    snapshotIdentity: 'history:test:4',
    snapshotItemCount: 1,
    modelInputItemCount: 2,
    currentTurnSuffix: [suffix],
  });
  expect(projection.projectedInput).toEqual([suffix]);
});

it('records a precise prefix mismatch without changing last-user fallback projection', () => {
  const projection = expectParity([{ role: 'user', type: 'message', content: 'expected' }], {
    input: [
      { role: 'assistant', type: 'message', content: 'different' },
      { role: 'user', content: 'now' },
    ],
  });

  expect(projection.prefix).toMatchObject({ kind: 'mismatch', matchedPrefixItems: 0, mismatchIndex: 0 });
  expect(projection.projectedInput).toEqual([{ role: 'user', content: 'now' }]);
});

it('preserves trailing tool-result selection and selected parallel outputs exactly', () => {
  const callA = { type: 'function_call', call_id: 'a', name: 'one', arguments: '{}' };
  const callB = { type: 'function_call', call_id: 'b', name: 'two', arguments: '{}' };
  const resultA = { type: 'function_call_output', call_id: 'a', output: 'A' };
  const resultB = { type: 'function_call_output', call_id: 'b', output: 'B' };
  const all = [callA, callB, resultA, resultB];

  const trailing = expectParity([], { input: all });
  expect(trailing.projectedInput).toEqual([resultA, resultB]);
  const selected = expectParity([], { input: all }, { toolResultCallIds: ['b'], knownToolCallIds: ['b'] });
  expect(selected.projectedInput).toEqual([resultB]);
});

it('preserves missing and orphan tool-output failures exactly', () => {
  const missing = projectOpenAIChainedModelInput(snapshot([]), { input: [] }, { toolResultCallIds: ['missing'] });
  expect(missing.error).toMatchObject({ name: 'MissingChainedToolOutputError', callIds: ['missing'] });

  const orphan = projectOpenAIChainedModelInput(
    snapshot([]),
    { input: [{ type: 'function_call_output', call_id: 'orphan', output: 'nope' }] },
    { toolResultCallIds: ['orphan'], knownToolCallIds: ['other'] },
  );
  expect(orphan.error).toMatchObject({ name: 'OrphanedChainedToolOutputError', callIds: ['orphan'] });
});
