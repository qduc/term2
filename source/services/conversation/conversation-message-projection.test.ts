import { expect, it } from 'vitest';
import { projectConversationMessage } from './conversation-message-projection.js';

it.each([
  {
    label: 'direct user message',
    item: {
      role: 'user',
      type: 'message',
      content: [
        { type: 'input_text', text: 'Describe ' },
        { type: 'input_image', image: 'data:image/png;base64,AAAA', detail: 'auto' },
        { type: 'output_text', text: 'this' },
      ],
    },
  },
  {
    label: 'one-level wrapped user message',
    item: {
      rawItem: {
        role: 'user',
        type: 'message',
        content: [
          { type: 'input_text', text: 'Describe ' },
          { type: 'input_image', image: 'data:image/png;base64,AAAA', detail: 'auto' },
          { type: 'output_text', text: 'this' },
        ],
      },
    },
  },
])('projects $label text and images equivalently', ({ item }) => {
  expect(projectConversationMessage(item)).toEqual({
    role: 'user',
    text: 'Describe this',
    images: [{ image: 'data:image/png;base64,AAAA', detail: 'auto' }],
    imageCount: 1,
    isSynthetic: false,
  });
});

it('projects assistant and system string messages', () => {
  expect(projectConversationMessage({ role: 'assistant', type: 'message', content: 'Answer' })).toMatchObject({
    role: 'assistant',
    text: 'Answer',
    imageCount: 0,
  });
  expect(projectConversationMessage({ role: 'system', type: 'message', content: 'Instruction' })).toMatchObject({
    role: 'system',
    text: 'Instruction',
    imageCount: 0,
  });
});

it('projects malformed or empty message content without treating non-messages as messages', () => {
  expect(projectConversationMessage({ role: 'user', type: 'message', content: { unexpected: true } })).toMatchObject({
    role: 'user',
    text: '',
    images: [],
    imageCount: 0,
  });
  expect(projectConversationMessage({ role: 'assistant', type: 'message', content: [] })).toMatchObject({ text: '' });
  expect(
    projectConversationMessage({ role: 'user', type: 'message', content: [{ type: 'input_image' }] }),
  ).toMatchObject({ images: [], imageCount: 1 });
  expect(projectConversationMessage({ role: 'user', type: 'function_call', content: 'not a message' })).toBeNull();
  expect(projectConversationMessage({ type: 'reasoning', text: 'not a message' })).toBeNull();
  expect(
    projectConversationMessage({ rawItem: { rawItem: { role: 'user', type: 'message', content: 'nested' } } }),
  ).toBeNull();
});

it('classifies current shell-context and legacy mode notices as synthetic user messages', () => {
  expect(
    projectConversationMessage({ role: 'user', type: 'message', content: '[Previous Shell Session]\n$ ls' })
      ?.isSynthetic,
  ).toBe(true);
  expect(
    projectConversationMessage({ role: 'user', type: 'message', content: '[Mode Notice] Plan mode on' })?.isSynthetic,
  ).toBe(true);
  expect(
    projectConversationMessage({ role: 'assistant', type: 'message', content: '[Mode Notice] Reply' })?.isSynthetic,
  ).toBe(false);
});
