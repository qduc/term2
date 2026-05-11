import test from 'ava';
import { createAiSdkLoggingFetch } from './ai-sdk-logging-fetch.js';

test('createAiSdkLoggingFetch logs request and response traffic around fetch', async (t) => {
  const logs: Array<{ message: string; meta: any }> = [];
  const wrapped = createAiSdkLoggingFetch({
    provider: 'openrouter',
    model: 'test-model',
    loggingService: {
      debug: (message: string, meta?: any) => {
        logs.push({ message, meta });
      },
      error: (message: string, meta?: any) => {
        logs.push({ message, meta });
      },
      getCorrelationId: () => 'trace-test',
    },
    fetchImpl: async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: 'hello' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  });

  const response = await wrapped('https://example.test/chat/completions', {
    method: 'POST',
    body: JSON.stringify({
      model: 'test-model',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'read_file' } }],
    }),
  });

  t.is(response.status, 200);
  await response.text();
  await new Promise((resolve) => setTimeout(resolve, 0));

  t.is(logs.length, 2);
  t.like(logs[0], {
    message: 'openrouter ai sdk request',
    meta: {
      eventType: 'provider.request.started',
      direction: 'sent',
      provider: 'openrouter',
      model: 'test-model',
      messageCount: 1,
      toolsCount: 1,
    },
  });
  t.deepEqual(logs[0].meta.messages, [{ role: 'user', content: 'hi' }]);
  t.like(logs[1], {
    message: 'openrouter ai sdk response',
    meta: {
      eventType: 'provider.response.received',
      direction: 'received',
      provider: 'openrouter',
      model: 'test-model',
      status: 200,
    },
  });
  t.is(logs[1].meta.text, 'hello');
});

test('createAiSdkLoggingFetch truncates raw streaming response text', async (t) => {
  const logs: Array<{ message: string; meta: any }> = [];
  const streamingBody = [
    ': OPENROUTER PROCESSING',
    '',
    'data: {"id":"chunk-1","choices":[{"delta":{"content":"Hello"}}]}',
    '',
    'data: {"id":"chunk-2","choices":[{"delta":{"content":" world"}}]}',
    '',
    'data: [DONE]',
    '',
    ...Array.from({ length: 220 }, () => 'data: {"noise":"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}'),
    'data: {"tail":"preserved"}',
  ].join('\n');

  const wrapped = createAiSdkLoggingFetch({
    provider: 'openrouter',
    model: 'test-model',
    loggingService: {
      debug: (message: string, meta?: any) => {
        logs.push({ message, meta });
      },
      error: (message: string, meta?: any) => {
        logs.push({ message, meta });
      },
      getCorrelationId: () => 'trace-test',
    },
    fetchImpl: async () =>
      new Response(streamingBody, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
  });

  const response = await wrapped('https://example.test/chat/completions', {
    method: 'POST',
    body: JSON.stringify({
      model: 'test-model',
      messages: [{ role: 'user', content: 'hi' }],
    }),
  });

  t.is(response.status, 200);
  await response.text();
  await new Promise((resolve) => setTimeout(resolve, 0));

  t.is(logs.length, 2);
  t.true(typeof logs[1].meta.text === 'string');
  t.true(logs[1].meta.text.length < streamingBody.length);
  t.true(logs[1].meta.text.startsWith(': OPENROUTER PROCESSING'));
  t.true(logs[1].meta.text.endsWith('data: {"tail":"preserved"}'));
  t.true(typeof logs[1].meta.payload.rawPreview === 'string');
  t.true(logs[1].meta.payload.rawPreview.length < streamingBody.length);
});
