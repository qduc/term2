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

it('ImportedConversationStateSchema accepts unknown tool-execution status and dispatchedAt', () => {
  const parsed = ImportedConversationStateSchema.parse({
    history: [],
    previousResponseId: null,
    toolLedger: [
      {
        turnId: 'turn-1',
        callId: 'call-1',
        toolName: 'shell',
        status: 'unknown',
        startedAt: '2026-05-26T00:00:00.000Z',
        dispatchedAt: '2026-05-26T00:00:00.500Z',
        completedAt: '2026-05-26T00:00:01.000Z',
        output: 'Outcome unobserved',
      },
    ],
  });

  expect(parsed.toolLedger?.[0]?.status).toBe('unknown');
  expect(parsed.toolLedger?.[0]?.dispatchedAt).toBe('2026-05-26T00:00:00.500Z');
});

it('ImportedConversationStateSchema migrates unrecognized historical statuses to aborted', () => {
  const parsed = ImportedConversationStateSchema.parse({
    history: [],
    previousResponseId: null,
    toolLedger: [
      {
        turnId: 'turn-1',
        callId: 'call-legacy',
        toolName: 'shell',
        status: 'pre-unknown-exotic-status',
        startedAt: '2026-05-26T00:00:00.000Z',
      },
    ],
  });

  expect(parsed.toolLedger?.[0]?.status).toBe('aborted');
});

it('ImportedConversationStateSchema still accepts statuses written before unknown existed', () => {
  const parsed = ImportedConversationStateSchema.parse({
    history: [],
    previousResponseId: null,
    toolLedger: [
      {
        turnId: 'turn-1',
        callId: 'call-old',
        toolName: 'shell',
        status: 'aborted',
        startedAt: '2026-05-26T00:00:00.000Z',
      },
    ],
  });

  expect(parsed.toolLedger?.[0]?.status).toBe('aborted');
});
