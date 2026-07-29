import { expect, expectTypeOf, it } from 'vitest';
import type { StreamedModelTurn, StreamedModelTurnInput } from './streamed-model-turn.js';

it('exposes one operation for one streamed model turn', () => {
  expectTypeOf<StreamedModelTurn>().toHaveProperty('stream');
  expectTypeOf<StreamedModelTurn>().not.toHaveProperty('generate');
});

it('permits media in user and assistant messages but keeps system messages text-only', () => {
  expectTypeOf<Extract<StreamedModelTurnInput, { role: 'system' }>['content']>().toEqualTypeOf<
    readonly { readonly type: 'text'; readonly text: string }[]
  >();
  const user: Extract<StreamedModelTurnInput, { role: 'user' }> = {
    type: 'message',
    role: 'user',
    content: [{ type: 'image', image: 'image-data' }],
  };
  const assistant: Extract<StreamedModelTurnInput, { role: 'assistant' }> = {
    type: 'message',
    role: 'assistant',
    content: [{ type: 'image', image: 'image-data' }],
  };
  expect(user.content[0]?.type).toBe('image');
  expect(assistant.content[0]?.type).toBe('image');
});
