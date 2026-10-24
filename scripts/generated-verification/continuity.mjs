import assert from 'node:assert/strict';
import fc from 'fast-check';
import { ProviderContinuity } from '../../source/services/provider-continuity.ts';
import {
  filterChainedModelInput,
  MissingChainedToolOutputError,
  OrphanedChainedToolOutputError,
} from '../../source/lib/chained-input-filter.ts';

const action = fc.record({
  count: fc.integer({ min: 1, max: 4 }),
  selected: fc.integer({ min: 1, max: 4 }),
  reverse: fc.boolean(),
  boundary: fc.constantFrom('keep', 'reset', 'break'),
  output: fc.jsonValue(),
});
export const continuityProperties = [
  {
    name: 'continuity.debt-filter',
    property: fc.property(fc.array(action, { minLength: 1, maxLength: 30 }), (actions) => {
      const continuity = new ProviderContinuity();
      for (const [step, a] of actions.entries()) {
        const ids = Array.from({ length: a.count }, (_, i) => `call-${step}-${i}`);
        const response = `response-${step}`;
        const snapshot = { revision: step + 1, identity: 'snapshot', history: [] };
        continuity.acceptSegment({
          kind: 'committed',
          lastResponseId: response,
          historyCommitted: true,
          snapshot,
          unsettledToolCallIds: [...ids, ids[0]],
        });
        assert.equal(continuity.previousResponseId, response);
        assert.deepEqual(continuity.outstandingToolCallIds, ids, 'lost or duplicated authoritative debt');
        const chosen = ids.slice(0, Math.min(a.selected, ids.length));
        const results = chosen.map((id) => ({ type: 'function_call_output', call_id: id, output: a.output }));
        if (a.reverse) results.reverse();
        const unrelated = { type: 'function_call_output', call_id: `old-${step}`, output: 'old' };
        const input = [
          { type: 'message', role: 'user', content: 'anchor' },
          unrelated,
          ...results,
          { type: 'message', role: 'user', content: 'next' },
        ];
        const request = { input, model: 'probe' };
        const before = structuredClone(request);
        const filtered = filterChainedModelInput(request, {
          toolResultCallIds: continuity.outstandingToolCallIds,
          knownToolCallIds: ids,
        });
        assert.deepEqual(
          filtered,
          { ...request, input: results },
          'filter changed selected output values/order or kept unrelated items',
        );
        assert.deepEqual(request, before, 'filter mutated request');
        assert.throws(
          () => filterChainedModelInput({ input: [] }, { toolResultCallIds: ids, knownToolCallIds: ids }),
          MissingChainedToolOutputError,
        );
        assert.throws(
          () =>
            filterChainedModelInput(
              { input: [unrelated] },
              { toolResultCallIds: [unrelated.call_id], knownToolCallIds: ids },
            ),
          OrphanedChainedToolOutputError,
        );
        // Actual calls in full history independently establish result ownership.
        const full = [
          ...ids.map((id) => ({ type: 'function_call', call_id: id, name: 'probe', arguments: '{}' })),
          ...results,
        ];
        assert.deepEqual(filterChainedModelInput({ input: full }, { toolResultCallIds: chosen }).input, results);
        if (a.boundary === 'keep') {
          assert.equal(continuity.prepareNewTurn(10), false, 'new user turn reused unpaid tool debt');
          assert.equal(continuity.previousResponseId, null);
          assert.deepEqual(continuity.outstandingToolCallIds, []);
        }
        if (a.boundary !== 'keep') {
          const lineage = continuity.lineage;
          if (a.boundary === 'reset') continuity.clear();
          else continuity.breakChaining();
          assert.equal(continuity.previousResponseId, null, 'retired anchor retained');
          assert.deepEqual(continuity.outstandingToolCallIds, [], 'retired tool debt retained');
          if (a.boundary === 'reset') {
            assert.equal(
              continuity.observeCandidate({
                responseId: response,
                lineage,
                identity: { provider: 'probe', endpoint: 'local', model: 'probe' },
                prefix: { revision: step, identity: 'snapshot' },
              }),
              false,
              'stale lineage candidate accepted',
            );
          }
          assert.equal(continuity.previousResponseId, null, 'retired anchor revived');
          assert.deepEqual(continuity.outstandingToolCallIds, []);
        }
      }
    }),
  },
];
