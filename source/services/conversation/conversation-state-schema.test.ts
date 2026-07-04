import { expect, it } from 'vitest';
import { ImportedConversationStateSchema } from './conversation-state-schema.js';

it('ImportedConversationStateSchema accepts the persisted state shape used by session import', () => {
  const parsed = ImportedConversationStateSchema.parse({
    history: [{ role: 'user', type: 'message', content: 'hi' }],
    previousResponseId: null,
    toolLedger: [
      {
        turnId: 'turn-1',
        callId: 'call-1',
        toolName: 'shell',
        status: 'completed',
        startedAt: '2026-05-26T00:00:00.000Z',
        completedAt: '2026-05-26T00:00:01.000Z',
        arguments: '{"command":"pwd"}',
        output: '/repo',
        historyItems: [
          { type: 'function_call', callId: 'call-1', name: 'shell', arguments: '{"command":"pwd"}' },
          { type: 'function_call_result', callId: 'call-1', output: '/repo' },
        ],
      },
    ],
  });

  expect(parsed.toolLedger?.[0]?.callId).toBe('call-1');
});

it('ImportedConversationStateSchema rejects malformed imported state before projection', () => {
  const parsed = ImportedConversationStateSchema.safeParse({
    history: 'not-history',
    previousResponseId: 123,
    toolLedger: [{ callId: 'missing-required-fields' }],
  });

  expect(parsed.success).toBe(false);
});
