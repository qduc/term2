import { it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  sanitizeSentTrafficBody,
  summarizeReceivedTraffic,
  ProviderTrafficArtifactStore,
  TRAFFIC_TEXT_LIMIT,
} from './provider-traffic.js';

const makeTempDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'term2-provider-traffic-'));

const readRequestFile = (filePath: string): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;

const expectedTruncation = (length: number): string => `[omitted ${length - TRAFFIC_TEXT_LIMIT} chars]`;

it('sanitizeSentTrafficBody truncates instruction-like fields and preserves user/tool content', () => {
  const longText = 'x'.repeat(1200);
  const body = {
    instructions: longText,
    input: [
      { role: 'user', content: 'keep user content' },
      { role: 'assistant', content: 'keep prior turns' },
      { role: 'tool', content: 'keep tool output' },
      {
        type: 'function_call',
        name: 'write_file',
        arguments: '{"path":"a.ts","content":"full arguments stay intact"}',
      },
    ],
    tools: [
      { type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: { path: {} } } } },
      { type: 'web_search_preview', name: 'web_search' },
    ],
  };

  const sanitized = sanitizeSentTrafficBody(body);

  expect(typeof sanitized.instructions === 'string').toBe(true);
  expect((sanitized.instructions as string).includes(expectedTruncation(longText.length))).toBe(true);
  expect((sanitized.instructions as string).length < longText.length).toBe(true);
  expect(sanitized.input).toEqual(body.input);
  expect(sanitized.tools).toEqual(['read_file', 'web_search']);
});

it('sanitizeSentTrafficBody truncates system and developer messages in messages-style bodies only', () => {
  const longText = 'y'.repeat(1105);
  const body = {
    messages: [
      { role: 'system', content: longText },
      { role: 'developer', content: longText },
      { role: 'user', content: 'leave me alone' },
      { role: 'tool', content: 'tool output stays' },
      { role: 'assistant', tool_calls: [{ id: 'call_1', function: { name: 'x', arguments: '{"n":1}' } }] },
    ],
    tools: [{ type: 'function', function: { name: 'apply_patch', parameters: { type: 'object' } } }],
  };

  const sanitized = sanitizeSentTrafficBody(body);
  const messages = sanitized.messages as Array<Record<string, unknown>>;

  expect(String(messages[0].content).includes(expectedTruncation(longText.length))).toBe(true);
  expect(String(messages[1].content).includes(expectedTruncation(longText.length))).toBe(true);
  expect(messages[2].content).toBe('leave me alone');
  expect(messages[3].content).toBe('tool output stays');
  expect(messages[4].tool_calls).toEqual(body.messages[4].tool_calls);
  expect(sanitized.tools).toEqual(['apply_patch']);
});

it('sanitizeSentTrafficBody truncates system message with content array', () => {
  const longText = 'z'.repeat(1200);
  const body = {
    messages: [
      { role: 'system', content: [{ type: 'text', text: longText, cache_control: { type: 'ephemeral' } }] },
      { role: 'user', content: 'hi' },
    ],
  };

  const sanitized = sanitizeSentTrafficBody(body);
  const messages = sanitized.messages as Array<Record<string, unknown>>;
  const systemContent = messages[0].content as Array<Record<string, unknown>>;

  expect(systemContent[0].type).toBe('text');
  expect(String(systemContent[0].text).startsWith('z'.repeat(TRAFFIC_TEXT_LIMIT))).toBe(true);
  expect(String(systemContent[0].text).includes(expectedTruncation(longText.length))).toBe(true);
  expect(systemContent[0].cache_control).toEqual({ type: 'ephemeral' });
  expect(messages[1].content).toBe('hi');
});

it('sanitizeSentTrafficBody truncates anthropic message api system prompt (string or content array)', () => {
  const longText = 'a'.repeat(1200);
  const bodyWithStringSystem = {
    system: longText,
    messages: [{ role: 'user', content: 'hi' }],
  };

  const sanitizedString = sanitizeSentTrafficBody(bodyWithStringSystem);
  expect(typeof sanitizedString.system === 'string').toBe(true);
  expect((sanitizedString.system as string).includes(expectedTruncation(longText.length))).toBe(true);
  expect((sanitizedString.system as string).length < longText.length).toBe(true);

  const bodyWithArraySystem = {
    system: [{ type: 'text', text: longText, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: 'hi' }],
  };

  const sanitizedArray = sanitizeSentTrafficBody(bodyWithArraySystem);
  const systemContent = sanitizedArray.system as Array<Record<string, unknown>>;
  expect(systemContent[0].type).toBe('text');
  expect(String(systemContent[0].text).startsWith('a'.repeat(TRAFFIC_TEXT_LIMIT))).toBe(true);
  expect(String(systemContent[0].text).includes(expectedTruncation(longText.length))).toBe(true);
  expect(systemContent[0].cache_control).toEqual({ type: 'ephemeral' });
});

it('sanitizeSentTrafficBody removes encrypted reasoning payload data from messages', () => {
  const body = {
    messages: [
      {
        role: 'assistant',
        content: 'keep assistant content',
        reasoning_details: [
          { type: 'reasoning.encrypted', data: 'opaque-ciphertext', id: 'r1' },
          { type: 'reasoning.summary', data: 'keep-readable', id: 'r2' },
        ],
      },
    ],
  };

  const sanitized = sanitizeSentTrafficBody(body);
  const messages = sanitized.messages as Array<Record<string, unknown>>;
  const reasoningDetails = messages[0].reasoning_details as Array<Record<string, unknown>>;

  expect(reasoningDetails).toEqual([
    { type: 'reasoning.encrypted', data: '', id: 'r1' },
    { type: 'reasoning.summary', data: 'keep-readable', id: 'r2' },
  ]);
  expect(messages[0].content).toBe('keep assistant content');
});

it('summarizeReceivedTraffic merges OpenAI Responses SSE text reasoning and tool arguments', async () => {
  const sse = [
    ': ping',
    '',
    'event: response.output_text.delta',
    'data: {"type":"response.output_text.delta","delta":"Hello"}',
    '',
    'event: response.reasoning_summary_text.delta',
    'data: {"type":"response.reasoning_summary_text.delta","delta":"Think"}',
    '',
    'event: response.function_call_arguments.delta',
    'data: {"type":"response.function_call_arguments.delta","item_id":"fc_1","delta":"{\\"a\\":"}',
    '',
    'event: response.function_call_arguments.delta',
    'data: {"type":"response.function_call_arguments.delta","item_id":"fc_1","delta":"1}"}',
    '',
    'event: response.completed',
    'data: {"type":"response.completed","response":{"id":"resp_1","status":"completed","usage":{"input_tokens":10,"output_tokens":5}}}',
    '',
    'data: [DONE]',
    '',
  ].join('\n');

  const summary = await summarizeReceivedTraffic(
    new Response(sse, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }),
  );

  expect(summary.transport).toBe('sse');
  expect(summary.status).toBe(200);
  expect((summary.payload as any)?.id).toBe('resp_1');
  expect((summary.payload as any)?.choices?.[0]?.delta?.content).toBe('Hello');
  expect((summary.payload as any)?.choices?.[0]?.delta?.reasoning).toBe('Think');
  expect((summary.payload as any)?.usage).toEqual({ input_tokens: 10, output_tokens: 5 });
  expect((summary.payload as any)?.choices?.[0]?.delta?.tool_calls).toEqual([
    {
      id: 'fc_1',
      type: 'function',
      function: { arguments: '{"a":1}' },
    },
  ]);
  expect(summary.unknownFrames).toEqual([]);
});

it('summarizeReceivedTraffic merges chat completions deltas and retains malformed and unknown frames', async () => {
  const sse = [
    'data: {"choices":[{"delta":{"content":"Hi","reasoning":"R","tool_calls":[{"index":0,"id":"call_1","function":{"name":"shell","arguments":"{\\"c"}}]}}]}',
    '',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"md\\":\\"ls\\"}"}}],"finish_reason":"tool_calls"}],"id":"resp_chat"}',
    '',
    'data: {"choices":[{"delta":{"mystery":"value"}}]}',
    '',
    'data: {"error":{"message":"bad upstream"}}',
    '',
    'data: {"bad_json"',
    '',
    'data: [DONE]',
    '',
  ].join('\n');

  const summary = await summarizeReceivedTraffic(
    new Response(sse, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }),
  );

  expect((summary.payload as any)?.choices?.[0]?.delta?.content).toBe('Hi');
  expect((summary.payload as any)?.choices?.[0]?.delta?.reasoning).toBe('R');
  expect((summary.payload as any)?.id).toBe('resp_chat');
  expect((summary.payload as any)?.choices?.[0]?.finish_reason).toBe('tool_calls');
  expect((summary.payload as any)?.choices?.[0]?.delta?.tool_calls).toEqual([
    {
      id: 'call_1',
      type: 'function',
      function: { name: 'shell', arguments: '{"cmd":"ls"}' },
    },
  ]);
  expect(summary.errorFrames.length).toBe(1);
  expect(summary.malformedFrames.length).toBe(1);
  expect(summary.unknownFrames.length).toBe(1);
  expect(summary.unknownFrames[0]?.count).toBe(1);
});

it('summarizeReceivedTraffic recognizes assistant role-only chunks and ignores cost-only trailers', async () => {
  const sse = [
    'data: {"id":"chatcmpl_1","object":"chat.completion.chunk","created":1779512639,"model":"accounts/fireworks/models/kimi-k2p6","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}],"usage":null}',
    '',
    'data: {"choices":[{"delta":{"content":"Hi"}}]}',
    '',
    'data: {"choices":[],"cost":"0"}',
    '',
    'data: [DONE]',
    '',
  ].join('\n');

  const summary = await summarizeReceivedTraffic(
    new Response(sse, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }),
  );

  expect((summary.payload as any)?.id).toBe('chatcmpl_1');
  expect((summary.payload as any)?.choices?.[0]?.delta?.content).toBe('Hi');
  expect(summary.unknownFrames).toEqual([]);
});

it('summarizeReceivedTraffic handles non-stream JSON and falls back safely for unknown JSON', async () => {
  const jsonSummary = await summarizeReceivedTraffic(
    new Response(
      JSON.stringify({
        id: 'resp_json',
        output_text: 'Done',
        usage: { input_tokens: 3, output_tokens: 2 },
      }),
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
      },
    ),
  );

  expect(jsonSummary.transport).toBe('json');
  expect((jsonSummary.payload as any)?.id).toBe('resp_json');
  expect((jsonSummary.payload as any)?.output_text).toBe('Done');
  expect((jsonSummary.payload as any)?.usage).toEqual({ input_tokens: 3, output_tokens: 2 });

  const fallbackSummary = await summarizeReceivedTraffic(
    new Response(JSON.stringify({ strange: { nested: true } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );

  expect(fallbackSummary.fallbackBody).toBeTruthy();
  expect((fallbackSummary.fallbackBody as any).strange.nested).toBe(true);
});

it('summarizeReceivedTraffic sniffs SSE body when content-type is missing', async () => {
  const sse = [
    'event: response.output_text.delta',
    'data: {"type":"response.output_text.delta","delta":"Hi"}',
    '',
    'event: response.completed',
    'data: {"type":"response.completed","response":{"id":"resp_sniff","status":"completed"}}',
    '',
    'data: [DONE]',
    '',
  ].join('\n');

  const summary = await summarizeReceivedTraffic(new Response(sse, { status: 200 }));

  expect(summary.transport).toBe('sse');
  expect((summary.payload as any)?.id).toBe('resp_sniff');
  expect((summary.payload as any)?.choices?.[0]?.delta?.content).toBe('Hi');
  expect(summary.fallbackBody).toBeFalsy();
});

it('summarizeReceivedTraffic sniffs JSON body when content-type is missing', async () => {
  const summary = await summarizeReceivedTraffic(
    new Response(JSON.stringify({ id: 'resp_json_sniff', output_text: 'Done' }), {
      status: 200,
    }),
  );

  expect(summary.transport).toBe('json');
  expect((summary.payload as any)?.id).toBe('resp_json_sniff');
  expect(summary.fallbackBody).toBeFalsy();
});

it('summarizeReceivedTraffic recognizes response.content_part.added as a lifecycle frame', async () => {
  const sse = [
    'data: {"type":"response.content_part.added","content_index":0,"item_id":"msg_1","output_index":0,"part":{"type":"output_text","annotations":[],"text":""},"sequence_number":1}',
    '',
    'data: {"type":"response.output_text.delta","delta":"Hello","sequence_number":2}',
    '',
    'data: [DONE]',
    '',
  ].join('\n');

  const summary = await summarizeReceivedTraffic(
    new Response(sse, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }),
  );

  expect(summary.unknownFrames).toEqual([]);
  expect((summary.payload as any)?.choices?.[0]?.delta?.content).toBe('Hello');
});

it('summarizeReceivedTraffic recognizes Responses API lifecycle frames without adding to unknownFrames', async () => {
  const sse = [
    'data: {"type":"response.created","response":{"id":"resp_abc","status":"in_progress","output":[]},"sequence_number":0}',
    '',
    'data: {"type":"response.in_progress","response":{"id":"resp_abc","status":"in_progress","output":[]},"sequence_number":1}',
    '',
    'data: {"type":"response.output_text.delta","delta":"Hello","sequence_number":2}',
    '',
    'data: {"type":"response.completed","response":{"id":"resp_abc","status":"completed","usage":{"input_tokens":5,"output_tokens":3}},"sequence_number":3}',
    '',
    'data: [DONE]',
    '',
  ].join('\n');

  const summary = await summarizeReceivedTraffic(
    new Response(sse, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }),
  );

  expect(summary.transport).toBe('sse');
  expect((summary.payload as any)?.id).toBe('resp_abc');
  expect((summary.payload as any)?.choices?.[0]?.delta?.content).toBe('Hello');
  expect(summary.unknownFrames).toEqual([]);
});

it('summarizeReceivedTraffic registers tool name from response.output_item.added function_call frame', async () => {
  const sse = [
    'data: {"type":"response.created","response":{"id":"resp_xyz","status":"in_progress","output":[]},"sequence_number":0}',
    '',
    'data: {"type":"response.output_item.added","item":{"id":"fc_1","type":"function_call","status":"in_progress","arguments":"","call_id":"call_abc","name":"shell"},"output_index":0,"sequence_number":1}',
    '',
    'data: {"type":"response.function_call_arguments.delta","item_id":"fc_1","delta":"{\\"cmd\\":\\"ls\\"}","sequence_number":2}',
    '',
    'data: {"type":"response.completed","response":{"id":"resp_xyz","status":"completed","usage":{"input_tokens":5,"output_tokens":10}},"sequence_number":3}',
    '',
    'data: [DONE]',
    '',
  ].join('\n');

  const summary = await summarizeReceivedTraffic(
    new Response(sse, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }),
  );

  expect(summary.unknownFrames).toEqual([]);
  const toolCalls = (summary.payload as any)?.choices?.[0]?.delta?.tool_calls;
  expect(toolCalls?.length).toBe(1);
  expect(toolCalls?.[0]?.function?.name).toBe('shell');
  expect(toolCalls?.[0]?.function?.arguments).toBe('{"cmd":"ls"}');
});

it('summarizeReceivedTraffic does not duplicate content from output_text.done after delta events', async () => {
  const sse = [
    'data: {"type":"response.output_text.delta","content_index":0,"item_id":"msg_1","output_index":0,"delta":"Hello! How can I help?","sequence_number":1}',
    '',
    'data: {"type":"response.output_text.done","content_index":0,"item_id":"msg_1","output_index":0,"logprobs":[],"sequence_number":2,"text":"Hello! How can I help?"}',
    '',
    'data: {"type":"response.content_part.done","content_index":0,"item_id":"msg_1","output_index":0,"part":{"type":"output_text","annotations":[],"text":"Hello! How can I help?"},"sequence_number":3}',
    '',
    'data: {"type":"response.output_item.done","item":{"id":"msg_1","type":"message","status":"completed","content":[{"type":"output_text","text":"Hello! How can I help?"}]},"output_index":0,"sequence_number":4}',
    '',
    'data: [DONE]',
    '',
  ].join('\n');

  const summary = await summarizeReceivedTraffic(
    new Response(sse, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }),
  );

  expect(summary.unknownFrames).toEqual([]);
  expect((summary.payload as any)?.choices?.[0]?.delta?.content).toBe('Hello! How can I help?');
});

it('ProviderTrafficArtifactStore writes per-day per-session request files and daily index', () => {
  const rootDir = makeTempDir();
  const store = new ProviderTrafficArtifactStore({ rootDir });

  store.recordRequestStart({
    requestId: 'req-1',
    timestamp: '2026-05-22T09:14:35.044Z',
    provider: 'openrouter',
    model: 'qwen/qwen3',
    modelClass: 'OpenAIResponsesWSModelWithPromptCacheKey',
    modelWrapperClass: 'RetryingModel',
    sessionId: 'session-123',
    sessionStartedAt: '2026-05-22T09:14:31.125Z',
    mode: 'standard',
    firstUserMessagePreview: 'hello there',
    headers: { host: 'api.openrouter.ai', authorization: '[REDACTED]' },
    sentBody: { messages: [{ role: 'user', content: 'hello there' }] },
  });

  const dayDir = path.join(rootDir, '2026-05-22');
  const sessionDir = path.join(dayDir, '09-14-31_sessi');
  const requestFile = path.join(sessionDir, '09-14-35.044Z_req-1.jsonl');

  expect(fs.existsSync(dayDir)).toBe(true);
  expect(fs.existsSync(sessionDir)).toBe(true);
  expect(fs.existsSync(requestFile)).toBe(true);
  expect(path.basename(requestFile)).toBe('09-14-35.044Z_req-1.jsonl');
  expect(path.basename(requestFile).includes('session-123')).toBe(false);

  const requestRecord = readRequestFile(requestFile);
  expect((requestRecord.sent as Record<string, unknown>)?.direction).toBe('sent');
  expect((requestRecord.sent as Record<string, unknown>)?.headers).toEqual({
    host: 'api.openrouter.ai',
    authorization: '[REDACTED]',
  });
  expect((requestRecord.sent as Record<string, unknown>)?.modelClass).toBe('OpenAIResponsesWSModelWithPromptCacheKey');
  expect((requestRecord.sent as Record<string, unknown>)?.modelWrapperClass).toBe('RetryingModel');
  expect(requestRecord.received).toEqual({});

  const indexPath = path.join(dayDir, 'index.jsonl');
  const indexEntries = fs
    .readFileSync(indexPath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(indexEntries.length).toBe(1);
  expect(indexEntries[0]).toMatchObject({
    sessionId: 'session-123',
    sessionDir: '09-14-31_sessi',
    firstRequestAt: '2026-05-22T09:14:35.044Z',
    lastRequestAt: '2026-05-22T09:14:35.044Z',
    requestCount: 1,
    latestProvider: 'openrouter',
    latestModel: 'qwen/qwen3',
    latestMode: 'standard',
  });
});

it('ProviderTrafficArtifactStore appends received line, upserts newest-first index, records failures, and allows later-day session folders', () => {
  const rootDir = makeTempDir();
  const legacyFile = path.join(rootDir, 'traffic-2026-05-22.log');
  fs.writeFileSync(legacyFile, '{"legacy":true}\n', 'utf8');

  const store = new ProviderTrafficArtifactStore({ rootDir });
  store.recordRequestStart({
    requestId: 'req-1',
    timestamp: '2026-05-22T09:14:35.044Z',
    provider: 'openai',
    model: 'gpt-5',
    modelClass: 'OpenAIResponsesWSModelWithPromptCacheKey',
    modelWrapperClass: 'RetryingModel',
    sessionId: 'session-123',
    sessionStartedAt: '2026-05-22T09:14:31.125Z',
    mode: 'standard',
    firstUserMessagePreview: 'first preview',
    sentBody: { input: [{ role: 'user', content: 'first preview' }] },
  });
  store.recordRequestComplete({
    requestId: 'req-1',
    timestamp: '2026-05-22T09:14:36.000Z',
    provider: 'openai',
    model: 'gpt-5',
    modelClass: 'OpenAIResponsesWSModelWithPromptCacheKey',
    modelWrapperClass: 'RetryingModel',
    sessionId: 'session-123',
    sessionStartedAt: '2026-05-22T09:14:31.125Z',
    mode: 'standard',
    receivedSummary: { status: 200, outputText: 'done' },
  });
  store.recordRequestStart({
    requestId: 'req-2',
    timestamp: '2026-05-22T10:00:00.000Z',
    provider: 'openrouter',
    model: 'deepseek/chat',
    modelClass: 'OpenAIResponsesWSModelWithPromptCacheKey',
    modelWrapperClass: 'RetryingModel',
    sessionId: 'session-999',
    sessionStartedAt: '2026-05-22T10:00:00.000Z',
    mode: 'mentor',
    firstUserMessagePreview: 'second preview',
    sentBody: { messages: [{ role: 'user', content: 'second preview' }] },
  });
  store.recordRequestComplete({
    requestId: 'req-2',
    timestamp: '2026-05-22T10:00:01.000Z',
    provider: 'openrouter',
    model: 'deepseek/chat',
    modelClass: 'OpenAIResponsesWSModelWithPromptCacheKey',
    modelWrapperClass: 'RetryingModel',
    sessionId: 'session-999',
    sessionStartedAt: '2026-05-22T10:00:00.000Z',
    mode: 'mentor',
    error: { message: 'fetch failed' },
  });
  store.recordRequestStart({
    requestId: 'req-3',
    timestamp: '2026-05-23T00:00:01.000Z',
    provider: 'openai',
    model: 'gpt-5',
    modelClass: 'OpenAIResponsesWSModelWithPromptCacheKey',
    modelWrapperClass: 'RetryingModel',
    sessionId: 'session-123',
    sessionStartedAt: '2026-05-23T00:00:00.000Z',
    mode: 'standard',
    firstUserMessagePreview: 'resumed later',
    sentBody: { input: [{ role: 'user', content: 'resumed later' }] },
  });

  const requestFile = path.join(rootDir, '2026-05-22', '09-14-31_sessi', '09-14-35.044Z_req-1.jsonl');
  const requestRecord = readRequestFile(requestFile);
  expect((requestRecord.sent as Record<string, unknown>)?.direction).toBe('sent');
  expect((requestRecord.received as Record<string, unknown>)?.direction).toBe('received');
  expect(((requestRecord.received as Record<string, unknown>)?.summary as any)?.outputText).toBe('done');
  expect((requestRecord.sent as Record<string, unknown>)?.modelClass).toBe('OpenAIResponsesWSModelWithPromptCacheKey');
  expect((requestRecord.sent as Record<string, unknown>)?.modelWrapperClass).toBe('RetryingModel');
  expect((requestRecord.received as Record<string, unknown>)?.modelClass).toBe(
    'OpenAIResponsesWSModelWithPromptCacheKey',
  );
  expect((requestRecord.received as Record<string, unknown>)?.modelWrapperClass).toBe('RetryingModel');

  const failureFile = path.join(rootDir, '2026-05-22', '10-00-00_sessi', '10-00-00.000Z_req-2.jsonl');
  const failureRecord = readRequestFile(failureFile);
  expect(((failureRecord.received as Record<string, unknown>)?.error as any)?.message).toBe('fetch failed');
  expect((failureRecord.sent as Record<string, unknown>)?.modelClass).toBe('OpenAIResponsesWSModelWithPromptCacheKey');
  expect((failureRecord.received as Record<string, unknown>)?.modelClass).toBe(
    'OpenAIResponsesWSModelWithPromptCacheKey',
  );

  const indexEntries = fs
    .readFileSync(path.join(rootDir, '2026-05-22', 'index.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(indexEntries.length).toBe(2);
  expect(indexEntries[0].sessionId).toBe('session-999');
  expect(indexEntries[1].sessionId).toBe('session-123');
  expect(indexEntries[0].providersSeen).toEqual(['openrouter']);
  expect(indexEntries[1].modelsSeen).toEqual(['gpt-5']);

  expect(fs.existsSync(path.join(rootDir, '2026-05-23', '00-00-00_sessi', '00-00-01.000Z_req-3.jsonl'))).toBe(true);
  expect(fs.readFileSync(legacyFile, 'utf8')).toBe('{"legacy":true}\n');
});

it('ProviderTrafficArtifactStore places evaluator requests under evaluator subfolder', () => {
  const rootDir = makeTempDir();
  const store = new ProviderTrafficArtifactStore({ rootDir });

  store.recordRequestStart({
    requestId: 'eval-req-1',
    timestamp: '2026-05-22T09:14:35.044Z',
    provider: 'openai',
    model: 'gpt-4o-mini',
    modelClass: 'CodexResponsesWSModel',
    modelWrapperClass: 'RetryingModel',
    sessionId: 'session-123',
    sessionStartedAt: '2026-05-22T09:14:31.125Z',
    mode: 'standard',
    sentBody: { messages: [] },
    evaluator: true,
  });
  store.recordRequestComplete({
    requestId: 'eval-req-1',
    timestamp: '2026-05-22T09:14:36.000Z',
    provider: 'openai',
    model: 'gpt-4o-mini',
    modelClass: 'CodexResponsesWSModel',
    modelWrapperClass: 'RetryingModel',
    sessionId: 'session-123',
    sessionStartedAt: '2026-05-22T09:14:31.125Z',
    mode: 'standard',
    receivedSummary: { status: 200, outputText: 'approved' },
    evaluator: true,
  });

  const dayDir = path.join(rootDir, '2026-05-22');
  const sessionDir = path.join(dayDir, '09-14-31_sessi');
  const requestFile = path.join(sessionDir, 'evaluator_09-14-35.044Z_eval-.jsonl');

  expect(fs.existsSync(dayDir)).toBe(true);
  expect(fs.existsSync(sessionDir)).toBe(true);
  expect(fs.existsSync(requestFile)).toBe(true);

  const records = readRequestFile(requestFile);
  expect((records.sent as Record<string, unknown>)?.direction).toBe('sent');
  expect((records.received as Record<string, unknown>)?.direction).toBe('received');
  expect((records.sent as Record<string, unknown>)?.modelClass).toBe('CodexResponsesWSModel');
  expect((records.received as Record<string, unknown>)?.modelClass).toBe('CodexResponsesWSModel');
});

it('recordRequestComplete removes completed request path from map so a second completion without a fresh start gets a new path', () => {
  const rootDir = makeTempDir();
  const store = new ProviderTrafficArtifactStore({ rootDir });

  const requestId = 'test-req-id';
  const startedAt = '2026-06-01T10:00:00.000Z';

  // Start the request — stores the computed path in the internal map
  store.recordRequestStart({
    requestId,
    timestamp: '2026-06-01T10:00:01.000Z',
    provider: 'openai',
    model: 'gpt-4',
    sessionId: 'session-cleanup',
    sessionStartedAt: startedAt,
    mode: 'standard',
    sentBody: { messages: [{ role: 'user', content: 'hello' }] },
  });

  // First completion — uses the stored path, then (after fix) removes it
  store.recordRequestComplete({
    requestId,
    timestamp: '2026-06-01T10:00:05.000Z',
    provider: 'openai',
    model: 'gpt-4',
    sessionId: 'session-cleanup',
    sessionStartedAt: startedAt,
    mode: 'standard',
    receivedSummary: { status: 200 },
  });

  // Second completion, same requestId, no fresh start — must fall back to #pathsFor
  store.recordRequestComplete({
    requestId,
    timestamp: '2026-06-01T10:00:10.000Z',
    provider: 'openai',
    model: 'gpt-4',
    sessionId: 'session-cleanup',
    sessionStartedAt: startedAt,
    mode: 'standard',
    receivedSummary: { status: 200 },
  });

  const dayDir = path.join(rootDir, '2026-06-01');
  const sessionDir = path.join(dayDir, '10-00-00_sessi');

  // The file created by recordRequestStart is rewritten in place with sent + first received.
  const startFile = path.join(sessionDir, '10-00-01.000Z_test-.jsonl');
  expect(fs.existsSync(startFile)).toBe(true);
  expect((readRequestFile(startFile).sent as Record<string, unknown>)?.direction).toBe('sent');
  expect((readRequestFile(startFile).received as Record<string, unknown>)?.direction).toBe('received');

  // The second completion MUST write to a NEW file, not reuse the stored path
  const secondFile = path.join(sessionDir, '10-00-10.000Z_test-.jsonl');
  expect(fs.existsSync(secondFile)).toBe(true);
  const secondRecords = readRequestFile(secondFile);
  expect((secondRecords.sent as Record<string, unknown>) ?? {}).toEqual({});
  expect((secondRecords.received as Record<string, unknown>)?.timestamp).toBe('2026-06-01T10:00:10.000Z');
});
