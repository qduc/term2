import { it, expect } from 'vitest';
import { adaptLegacyModel } from './legacy-compat.js';
import type { StreamedModelTurnRequest } from '../../contracts/streamed-model-turn.js';

async function drain(source: AsyncIterable<unknown>): Promise<void> {
  for await (const _event of source) {
    // drain
  }
}

it('adaptLegacyModel wraps tools with type: function before calling a legacy model', async () => {
  let capturedRequest: any;
  const legacyModel = {
    async *getStreamedResponse(request: any) {
      capturedRequest = request;
      yield { type: 'response_done', response: { id: 'resp_1', output: [] } };
    },
  };

  const adapted = adaptLegacyModel(legacyModel);
  const request: StreamedModelTurnRequest = {
    input: [],
    tools: [{ name: 'shell', description: 'Run shell.', parameters: { type: 'object' }, strict: true }],
  } as any;

  await drain(adapted.stream(request));

  expect(capturedRequest.tools).toEqual([
    { type: 'function', name: 'shell', description: 'Run shell.', parameters: { type: 'object' }, strict: true },
  ]);
});

it('adaptLegacyModel passes an unmodified legacy model straight through when it already has stream()', () => {
  const nativeModel = { stream: async function* () {} };
  expect(adaptLegacyModel(nativeModel)).toBe(nativeModel);
});

it('adaptLegacyModel translates tool_result input items into legacy function_call_result items', async () => {
  let capturedRequest: any;
  const legacyModel = {
    async *getStreamedResponse(request: any) {
      capturedRequest = request;
      yield { type: 'response_done', response: { id: 'resp_1', output: [] } };
    },
  };

  const adapted = adaptLegacyModel(legacyModel);
  const request: StreamedModelTurnRequest = {
    input: [{ type: 'tool_result', id: 'call_1', output: 'ok' }],
    tools: [],
  } as any;

  await drain(adapted.stream(request));

  expect(capturedRequest.input).toEqual([{ type: 'function_call_result', callId: 'call_1', output: { text: 'ok' } }]);
});
