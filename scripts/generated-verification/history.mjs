import assert from 'node:assert/strict';
import fc from 'fast-check';
import { projectProviderHistory } from '../../source/services/conversation/conversation-state-projector.ts';

// projectProviderHistory's contract: stateless, non-mutating, idempotent;
// dropUnpairedFunctionCalls: retain complete pairs, discard orphan sides.
export const historyProperties = [
  {
    name: 'history.pair-projection',
    property: fc.property(
      fc.array(fc.record({ paired: fc.boolean(), output: fc.string(), arguments: fc.jsonValue() }), { maxLength: 30 }),
      (entries) => {
        const history = entries.flatMap((entry, index) => [
          {
            type: 'function_call',
            call_id: `call-${index}`,
            name: 'probe',
            arguments: JSON.stringify(entry.arguments),
          },
          ...(entry.paired ? [{ type: 'function_call_output', call_id: `call-${index}`, output: entry.output }] : []),
        ]);
        history.push({ type: 'function_call_output', call_id: 'orphan', output: '' });
        const before = structuredClone(history);
        const projected = projectProviderHistory({ history });
        assert.deepEqual(history, before, 'projection mutated input');
        const expected = before.filter(
          (item) => item.call_id !== 'orphan' && entries[Number(item.call_id.slice(5))].paired,
        );
        assert.deepEqual(projected.history, expected, 'complete pairs changed or orphan survived');
        assert.deepEqual(
          projectProviderHistory({ history: projected.history }).history,
          projected.history,
          'not idempotent',
        );
      },
    ),
  },
];
