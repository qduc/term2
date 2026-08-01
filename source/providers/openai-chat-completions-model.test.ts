import { it, expect } from 'vitest';
import { OpenAIChatCompletionsModel } from './openai-chat-completions-model.js';

async function* emptyStream(): AsyncIterable<any> {}

it('stream() sends message content as OpenAI-compatible content parts, not raw strings', async () => {
  let capturedBody: any;
  const client = {
    chat: {
      completions: {
        create: async (body: any) => {
          capturedBody = body;
          return emptyStream();
        },
      },
    },
  };

  const model = new OpenAIChatCompletionsModel(client, 'deepseek-v4-flash');
  const request = {
    input: [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'text', text: 'docs/plans/decouple-from-openai-agents-sdk.md check progress' }],
      },
    ],
    tools: [],
  } as any;

  for await (const _event of model.stream(request)) {
    // drain
  }

  expect(capturedBody.messages).toEqual([
    {
      role: 'user',
      content: [{ type: 'text', text: 'docs/plans/decouple-from-openai-agents-sdk.md check progress' }],
    },
  ]);
});
