import { describe, expect, it } from 'vitest';
import { selectAgentStreamItems } from './agent-stream.js';

describe('selectAgentStreamItems', () => {
  it('unwraps item events and keeps unknown provider entries', () => {
    const items = selectAgentStreamItems({
      output: [],
      newItems: [{ type: 'item', item: { type: 'message', role: 'assistant' } }, { type: 'something_else' }],
      history: [],
    });

    expect(items).toEqual([{ type: 'message', role: 'assistant' }, { type: 'something_else' }]);
  });

  // Budget/stall evidence is a run event, not provider history. Mentor
  // continuation feeds this list straight into the next request, so a leak here
  // would replay a fired stage back to the model.
  it('drops run_budget events alongside the other non-history events', () => {
    const nonHistory = [
      { type: 'run_budget', evidence: { type: 'budget_stage', stage: 'warning', evidence: {} } },
      { type: 'cost_update', record: {} },
      { type: 'usage_update', usage: {} },
      { type: 'text_delta', delta: 'hi' },
    ];

    expect(selectAgentStreamItems({ output: nonHistory, newItems: [], history: [] })).toEqual([]);
    expect(selectAgentStreamItems({ output: [], newItems: nonHistory, history: [] })).toEqual([]);
  });

  it('falls back to history when a run produced only budget evidence', () => {
    const history = [{ type: 'message', role: 'user' }];

    const items = selectAgentStreamItems({
      output: [{ type: 'run_budget', evidence: { type: 'tool_stall' } }],
      newItems: [],
      history,
    });

    expect(items).toEqual(history);
  });
});
