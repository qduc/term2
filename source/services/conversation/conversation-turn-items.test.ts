import { it, expect } from 'vitest';
import { buildPersistedAssistantTurnItems, synthesizeHistoryFromAssistantTurn } from './conversation-turn-items.js';

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
