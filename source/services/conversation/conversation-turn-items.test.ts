import { it, expect } from 'vitest';
import {
  buildPersistedAssistantTurnItems,
  projectPersistedAssistantItemToProviderHistory,
  synthesizeHistoryFromAssistantTurn,
} from './conversation-turn-items.js';
import type { ProviderOpaqueItem } from '../../contracts/conversation-items.js';

// Some providers (e.g. openai-compatible / deepseek via opencode) emit reasoning
// items whose text lives in a `rawContent` array of `{ type: 'reasoning_text', text }`
// parts rather than in `content`, `text`, or `reasoning_content`. These must still
// be captured so the reasoning survives a persist -> resume round trip.
it('buildPersistedAssistantTurnItems captures reasoning text from rawContent', () => {
  const items = [
    {
      type: 'reasoning',
      content: [],
      rawContent: [{ type: 'reasoning_text', text: 'The user wants the kernel version.' }],
    },
  ];

  const persisted = buildPersistedAssistantTurnItems(items);

  expect(persisted.length).toBe(1);
  expect(persisted[0].type).toBe('reasoning');
  expect((persisted[0] as { text: string }).text).toBe('The user wants the kernel version.');
});

it('synthesizeHistoryFromAssistantTurn round-trips rawContent reasoning into history', () => {
  const items = [
    {
      type: 'reasoning',
      content: [],
      rawContent: [{ type: 'reasoning_text', text: 'Think about it.' }],
    },
    {
      role: 'assistant',
      type: 'message',
      content: [{ type: 'output_text', text: 'Your kernel is Darwin.' }],
    },
  ];

  const turn = { items: buildPersistedAssistantTurnItems(items) };
  const history = synthesizeHistoryFromAssistantTurn([], turn) as Array<Record<string, any>>;

  // The reasoning content must be recoverable somewhere in the synthesized history.
  const serialized = JSON.stringify(history);
  expect(serialized.includes('Think about it.')).toBe(true);
});

// The SDK's chat-completions converter reads a standalone reasoning item's
// `content[0].text` and attaches it to the following assistant/tool-call message
// at message level. Folding reasoning into a function_call's providerData instead
// makes it serialize onto BOTH the message and the tool-call (duplicate
// reasoning_content). Reasoning must be reconstructed as a standalone item.
it('synthesizeHistoryFromAssistantTurn reconstructs reasoning before a tool_call as a standalone item, not folded into the tool call', () => {
  const items = [
    {
      type: 'reasoning',
      content: [],
      rawContent: [{ type: 'reasoning_text', text: "I'll run uname -a." }],
    },
    {
      type: 'function_call',
      callId: 'call_1',
      name: 'shell',
      arguments: '{"command":"uname -a"}',
    },
  ];

  const turn = { items: buildPersistedAssistantTurnItems(items) };
  const history = synthesizeHistoryFromAssistantTurn([], turn) as Array<Record<string, any>>;

  const reasoningItem = history.find((h) => h.type === 'reasoning');
  expect(reasoningItem).toBeTruthy();
  expect(reasoningItem?.content?.[0]?.text).toBe("I'll run uname -a.");

  const toolCall = history.find((h) => h.type === 'function_call');
  expect(toolCall).toBeTruthy();
  const serializedToolCall = JSON.stringify(toolCall);
  expect(serializedToolCall.includes("I'll run uname -a.")).toBe(false);
});

it('retains the OpenAI-compatible reasoning continuation marker while removing duplicate reasoning_content', () => {
  const turn = {
    items: buildPersistedAssistantTurnItems([
      {
        type: 'reasoning',
        content: [{ type: 'reasoning_text', text: 'Need the native thinking trace.' }],
        providerData: {
          reasoning_content: 'Need the native thinking trace.',
          openai_compatible_reasoning_content: true,
        },
      },
      { type: 'function_call', callId: 'call_1', name: 'lookup', arguments: '{}' },
    ]),
  };

  const history = synthesizeHistoryFromAssistantTurn([], turn) as Array<Record<string, any>>;
  const reasoning = history.find((item) => item.type === 'reasoning');
  expect(reasoning?.providerData).toEqual({ openai_compatible_reasoning_content: true });
  expect(reasoning?.providerData).not.toHaveProperty('reasoning_content');
});

it('resumes persisted Codex encrypted reasoning immediately before its tool call', () => {
  const history = synthesizeHistoryFromAssistantTurn([], {
    items: [
      {
        type: 'reasoning',
        text: 'Use the lookup tool.',
        providerItemId: 'rs_codex',
        providerMetadata: { codex: { encrypted_content: 'cipher' } },
      },
      { type: 'tool_call', callId: 'call_codex', toolName: 'lookup', arguments: '{}', providerItem: {} },
    ],
  }) as Array<Record<string, any>>;

  expect(history).toEqual([
    {
      type: 'reasoning',
      id: 'rs_codex',
      content: [{ type: 'reasoning_text', text: 'Use the lookup tool.' }],
      rawContent: [{ type: 'reasoning_text', text: 'Use the lookup tool.' }],
      providerData: { codex: { encrypted_content: 'cipher' } },
    },
    expect.objectContaining({ type: 'function_call', callId: 'call_codex', name: 'lookup' }),
  ]);
});

it('synthesizeHistoryFromAssistantTurn serializes persisted object tool-call arguments for provider replay', () => {
  const turn = {
    items: [
      {
        type: 'tool_call' as const,
        callId: 'call-1',
        toolName: 'shell',
        arguments: {
          command: 'git status --short',
          timeout_ms: 120000,
          max_output_length: 12000,
          sandbox: 'default',
        },
      },
    ],
  };

  const history = synthesizeHistoryFromAssistantTurn([], turn) as Array<Record<string, any>>;

  expect(history).toEqual([
    {
      type: 'function_call',
      callId: 'call-1',
      name: 'shell',
      arguments: '{"command":"git status --short","timeout_ms":120000,"max_output_length":12000,"sandbox":"default"}',
    },
  ]);
});

it('synthesizeHistoryFromAssistantTurn projects provider-native tool spellings without losing metadata', () => {
  const turn = {
    items: [
      {
        type: 'tool_call' as const,
        callId: 'persisted-call',
        toolName: 'shell',
        arguments: 'fallback arguments',
        providerItem: {
          type: 'function_call',
          id: 'provider-call-item',
          tool_call_id: 'provider-call',
          name: 'shell',
          args: { command: 'pwd' },
          providerData: { vendor_trace: 'trace-1' },
        },
      },
      {
        type: 'tool_result' as const,
        callId: 'persisted-call',
        toolName: 'shell',
        status: 'completed' as const,
        output: 'fallback output',
        providerItem: {
          type: 'function_call_result',
          id: 'provider-result-item',
          call_id: 'provider-call',
          name: 'shell',
          result: { stdout: '/repo' },
          providerData: { vendor_trace: 'trace-2' },
        },
      },
    ],
  };

  const history = synthesizeHistoryFromAssistantTurn([], turn) as Array<Record<string, any>>;

  expect(history).toEqual([
    {
      type: 'function_call',
      id: 'provider-call-item',
      tool_call_id: 'provider-call',
      name: 'shell',
      args: { command: 'pwd' },
      providerData: { vendor_trace: 'trace-1' },
      callId: 'provider-call',
      arguments: '{"command":"pwd"}',
    },
    {
      type: 'function_call_result',
      id: 'provider-result-item',
      call_id: 'provider-call',
      name: 'shell',
      result: { stdout: '/repo' },
      providerData: { vendor_trace: 'trace-2' },
      callId: 'provider-call',
      output: { stdout: '/repo' },
    },
  ]);
});

// Step 2 of docs/plans/openai-context-compaction.md: a persisted provider_opaque
// item must project back to a ProviderInputItem carrying the `providerOpaque`
// marker from Step 1, so `normalizeInputItem` (application-run-loop.ts) accepts
// it on replay instead of throwing `Unsupported restored input item type: …`.
it('projectPersistedAssistantItemToProviderHistory restores the provider_opaque item verbatim with the providerOpaque marker', () => {
  const item: ProviderOpaqueItem = {
    type: 'provider_opaque',
    provider: 'openai',
    item: {
      id: 'comp_1',
      type: 'compaction',
      encrypted_content: 'ciphertext-blob',
      created_by: 'model',
      some_unknown_field: { nested: true },
    },
  };

  expect(projectPersistedAssistantItemToProviderHistory(item)).toEqual({
    id: 'comp_1',
    type: 'compaction',
    encrypted_content: 'ciphertext-blob',
    created_by: 'model',
    some_unknown_field: { nested: true },
    providerOpaque: { provider: 'openai' },
  });
});

it('synthesizeHistoryFromAssistantTurn carries a provider_opaque item into history unchanged', () => {
  const turn = {
    items: [
      {
        type: 'provider_opaque' as const,
        provider: 'openai',
        item: { id: 'comp_1', type: 'compaction', encrypted_content: 'ciphertext-blob' },
      },
    ],
  };

  const history = synthesizeHistoryFromAssistantTurn([], turn) as Array<Record<string, unknown>>;

  expect(history).toEqual([
    {
      id: 'comp_1',
      type: 'compaction',
      encrypted_content: 'ciphertext-blob',
      providerOpaque: { provider: 'openai' },
    },
  ]);
});

it('synthesizeHistoryFromAssistantTurn does not fold a provider_opaque item into the reasoning fallback', () => {
  // Regression guard: provider_opaque must not fall through to the final
  // reasoning-shaped branch of projectPersistedAssistantItemToProviderHistory,
  // which would read .text/.providerItemId (absent on this item) and produce
  // a malformed `{ type: 'reasoning', ... }` history entry instead.
  const turn = {
    items: [
      {
        type: 'provider_opaque' as const,
        provider: 'openai',
        item: { type: 'compaction', encrypted_content: 'x' },
      },
    ],
  };

  const history = synthesizeHistoryFromAssistantTurn([], turn) as Array<Record<string, unknown>>;
  expect(history).toHaveLength(1);
  expect(history[0]?.type).toBe('compaction');
});
