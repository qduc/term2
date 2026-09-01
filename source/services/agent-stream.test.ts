import { describe, expect, it } from 'vitest';
import { selectAgentStreamItems, streamHasCommittedOutput } from './agent-stream.js';

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

describe('streamHasCommittedOutput', () => {
  // outputPush() in application-run-loop.ts pushes run_budget evidence and
  // context_compaction_* lifecycle events unconditionally -- even for a
  // request that failed before producing anything. Treating their mere
  // presence as "committed output" blocked otherwise-safe chain_recovery/
  // transient retries for the ordinary case of a request that never streamed
  // a token. codex_rate_limits is quota metadata, same story.
  it('is false for bookkeeping-only events (run_budget, context_compaction_*, codex_rate_limits)', () => {
    const bookkeeping = [
      { type: 'run_budget', evidence: { type: 'budget_stage', stage: 'warning' } },
      { type: 'context_compaction_started', provider: 'openai' },
      { type: 'context_compaction_completed', provider: 'openai', durationMs: 12 },
      { type: 'context_compaction_failed', provider: 'openai', durationMs: 12 },
      { type: 'codex_rate_limits', rateLimits: {} },
    ];

    expect(streamHasCommittedOutput({ output: bookkeeping, newItems: [] })).toBe(false);
    expect(streamHasCommittedOutput({ output: [], newItems: bookkeeping })).toBe(false);
    expect(streamHasCommittedOutput({ output: [], newItems: [] })).toBe(false);
  });

  it('is true once real streamed text is present', () => {
    expect(
      streamHasCommittedOutput({
        output: [
          { type: 'run_budget', evidence: {} },
          { type: 'text_delta', text: 'partial answer' },
        ],
        newItems: [],
      }),
    ).toBe(true);
  });

  it('is true once a committed item (message, tool call, tool result) is present', () => {
    expect(
      streamHasCommittedOutput({
        output: [],
        newItems: [{ type: 'item', item: { type: 'message', role: 'assistant' } }],
      }),
    ).toBe(true);
  });

  it('is true once a tool call has been dispatched, even with no other output', () => {
    expect(
      streamHasCommittedOutput({
        output: [{ type: 'tool_call_dispatched', callId: 'call-1', toolName: 'bash' }],
        newItems: [],
      }),
    ).toBe(true);
  });

  it('is true for an entry with no recognizable type, erring toward blocking replay', () => {
    expect(streamHasCommittedOutput({ output: [{ unexpected: 'shape' }], newItems: [] })).toBe(true);
    expect(streamHasCommittedOutput({ output: [null, 'not-an-object'], newItems: [] })).toBe(true);
  });
});
