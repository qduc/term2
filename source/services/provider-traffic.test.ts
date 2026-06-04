import test from 'ava';
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

const readRequestFile = (filePath: string): Record<string, unknown>[] =>
  fs
    .readFileSync(filePath, 'utf8')
    .split(/\n\n/)
    .filter((block) => block.trim())
    .map((block) => JSON.parse(block) as Record<string, unknown>);

const expectedTruncation = (length: number): string => `[omitted ${length - TRAFFIC_TEXT_LIMIT} chars]`;

test('sanitizeSentTrafficBody truncates instruction-like fields and preserves user/tool content', (t) => {
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

  t.true(typeof sanitized.instructions === 'string');
  t.true((sanitized.instructions as string).includes(expectedTruncation(longText.length)));
  t.is((sanitized.instructions as string).length < longText.length, true);
  t.deepEqual(sanitized.input, body.input);
  t.deepEqual(sanitized.tools, ['read_file', 'web_search']);
});

test('sanitizeSentTrafficBody truncates system and developer messages in messages-style bodies only', (t) => {
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

  t.true(String(messages[0].content).includes(expectedTruncation(longText.length)));
  t.true(String(messages[1].content).includes(expectedTruncation(longText.length)));
  t.is(messages[2].content, 'leave me alone');
  t.is(messages[3].content, 'tool output stays');
  t.deepEqual(messages[4].tool_calls, body.messages[4].tool_calls);
  t.deepEqual(sanitized.tools, ['apply_patch']);
});

test('sanitizeSentTrafficBody truncates system message with content array', (t) => {
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

  t.is(systemContent[0].type, 'text');
  t.true(String(systemContent[0].text).startsWith('z'.repeat(TRAFFIC_TEXT_LIMIT)));
  t.true(String(systemContent[0].text).includes(expectedTruncation(longText.length)));
  t.deepEqual(systemContent[0].cache_control, { type: 'ephemeral' });
  t.is(messages[1].content, 'hi');
});

test('sanitizeSentTrafficBody truncates anthropic message api system prompt (string or content array)', (t) => {
  const longText = 'a'.repeat(1200);
  const bodyWithStringSystem = {
    system: longText,
    messages: [{ role: 'user', content: 'hi' }],
  };

  const sanitizedString = sanitizeSentTrafficBody(bodyWithStringSystem);
  t.true(typeof sanitizedString.system === 'string');
  t.true((sanitizedString.system as string).includes(expectedTruncation(longText.length)));
  t.is((sanitizedString.system as string).length < longText.length, true);

  const bodyWithArraySystem = {
    system: [{ type: 'text', text: longText, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: 'hi' }],
  };

  const sanitizedArray = sanitizeSentTrafficBody(bodyWithArraySystem);
  const systemContent = sanitizedArray.system as Array<Record<string, unknown>>;
  t.is(systemContent[0].type, 'text');
  t.true(String(systemContent[0].text).startsWith('a'.repeat(TRAFFIC_TEXT_LIMIT)));
  t.true(String(systemContent[0].text).includes(expectedTruncation(longText.length)));
  t.deepEqual(systemContent[0].cache_control, { type: 'ephemeral' });
});

test('sanitizeSentTrafficBody removes encrypted reasoning payload data from messages', (t) => {
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

  t.deepEqual(reasoningDetails, [
    { type: 'reasoning.encrypted', data: '', id: 'r1' },
    { type: 'reasoning.summary', data: 'keep-readable', id: 'r2' },
  ]);
  t.is(messages[0].content, 'keep assistant content');
});

test('summarizeReceivedTraffic merges OpenAI Responses SSE text reasoning and tool arguments', async (t) => {
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

  t.is(summary.transport, 'sse');
  t.is(summary.status, 200);
  t.is((summary.payload as any)?.id, 'resp_1');
  t.is((summary.payload as any)?.choices?.[0]?.delta?.content, 'Hello');
  t.is((summary.payload as any)?.choices?.[0]?.delta?.reasoning, 'Think');
  t.deepEqual((summary.payload as any)?.usage, { input_tokens: 10, output_tokens: 5 });
  t.deepEqual((summary.payload as any)?.choices?.[0]?.delta?.tool_calls, [
    {
      id: 'fc_1',
      type: 'function',
      function: { arguments: '{"a":1}' },
    },
  ]);
  t.deepEqual(summary.unknownFrames, []);
});

test('summarizeReceivedTraffic merges chat completions deltas and retains malformed and unknown frames', async (t) => {
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

  t.is((summary.payload as any)?.choices?.[0]?.delta?.content, 'Hi');
  t.is((summary.payload as any)?.choices?.[0]?.delta?.reasoning, 'R');
  t.is((summary.payload as any)?.id, 'resp_chat');
  t.is((summary.payload as any)?.choices?.[0]?.finish_reason, 'tool_calls');
  t.deepEqual((summary.payload as any)?.choices?.[0]?.delta?.tool_calls, [
    {
      id: 'call_1',
      type: 'function',
      function: { name: 'shell', arguments: '{"cmd":"ls"}' },
    },
  ]);
  t.is(summary.errorFrames.length, 1);
  t.is(summary.malformedFrames.length, 1);
  t.is(summary.unknownFrames.length, 1);
  t.is(summary.unknownFrames[0]?.count, 1);
});

test('summarizeReceivedTraffic recognizes assistant role-only chunks and ignores cost-only trailers', async (t) => {
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

  t.is((summary.payload as any)?.id, 'chatcmpl_1');
  t.is((summary.payload as any)?.choices?.[0]?.delta?.content, 'Hi');
  t.deepEqual(summary.unknownFrames, []);
});

test('summarizeReceivedTraffic handles non-stream JSON and falls back safely for unknown JSON', async (t) => {
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

  t.is(jsonSummary.transport, 'json');
  t.is((jsonSummary.payload as any)?.id, 'resp_json');
  t.is((jsonSummary.payload as any)?.output_text, 'Done');
  t.deepEqual((jsonSummary.payload as any)?.usage, { input_tokens: 3, output_tokens: 2 });

  const fallbackSummary = await summarizeReceivedTraffic(
    new Response(JSON.stringify({ strange: { nested: true } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );

  t.truthy(fallbackSummary.fallbackBody);
  t.is((fallbackSummary.fallbackBody as any).strange.nested, true);
});

test('summarizeReceivedTraffic sniffs SSE body when content-type is missing', async (t) => {
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

  t.is(summary.transport, 'sse');
  t.is((summary.payload as any)?.id, 'resp_sniff');
  t.is((summary.payload as any)?.choices?.[0]?.delta?.content, 'Hi');
  t.falsy(summary.fallbackBody);
});

test('summarizeReceivedTraffic sniffs JSON body when content-type is missing', async (t) => {
  const summary = await summarizeReceivedTraffic(
    new Response(JSON.stringify({ id: 'resp_json_sniff', output_text: 'Done' }), {
      status: 200,
    }),
  );

  t.is(summary.transport, 'json');
  t.is((summary.payload as any)?.id, 'resp_json_sniff');
  t.falsy(summary.fallbackBody);
});

test('summarizeReceivedTraffic recognizes response.content_part.added as a lifecycle frame', async (t) => {
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

  t.deepEqual(summary.unknownFrames, []);
  t.is((summary.payload as any)?.choices?.[0]?.delta?.content, 'Hello');
});

test('summarizeReceivedTraffic recognizes Responses API lifecycle frames without adding to unknownFrames', async (t) => {
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

  t.is(summary.transport, 'sse');
  t.is((summary.payload as any)?.id, 'resp_abc');
  t.is((summary.payload as any)?.choices?.[0]?.delta?.content, 'Hello');
  t.deepEqual(summary.unknownFrames, []);
});

test('summarizeReceivedTraffic registers tool name from response.output_item.added function_call frame', async (t) => {
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

  t.deepEqual(summary.unknownFrames, []);
  const toolCalls = (summary.payload as any)?.choices?.[0]?.delta?.tool_calls;
  t.is(toolCalls?.length, 1);
  t.is(toolCalls?.[0]?.function?.name, 'shell');
  t.is(toolCalls?.[0]?.function?.arguments, '{"cmd":"ls"}');
});

test('summarizeReceivedTraffic does not duplicate content from output_text.done after delta events', async (t) => {
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

  t.deepEqual(summary.unknownFrames, []);
  t.is((summary.payload as any)?.choices?.[0]?.delta?.content, 'Hello! How can I help?');
});

test('ProviderTrafficArtifactStore writes per-day per-session request files and daily index', (t) => {
  const rootDir = makeTempDir();
  const store = new ProviderTrafficArtifactStore({ rootDir });

  store.recordRequestStart({
    requestId: 'req-1',
    timestamp: '2026-05-22T09:14:35.044Z',
    provider: 'openrouter',
    model: 'qwen/qwen3',
    modelClass: 'TimedOpenAIResponsesWSModel',
    modelWrapperClass: 'FallbackResponsesModel',
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

  t.true(fs.existsSync(dayDir));
  t.true(fs.existsSync(sessionDir));
  t.true(fs.existsSync(requestFile));
  t.is(path.basename(requestFile), '09-14-35.044Z_req-1.jsonl');
  t.false(path.basename(requestFile).includes('session-123'));

  const firstRecord = readRequestFile(requestFile)[0];
  t.is(firstRecord?.direction, 'sent');
  t.deepEqual(firstRecord?.headers, { host: 'api.openrouter.ai', authorization: '[REDACTED]' });
  t.is(firstRecord?.modelClass, 'TimedOpenAIResponsesWSModel');
  t.is(firstRecord?.modelWrapperClass, 'FallbackResponsesModel');

  const indexPath = path.join(dayDir, 'index.jsonl');
  const indexEntries = fs
    .readFileSync(indexPath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  t.is(indexEntries.length, 1);
  t.like(indexEntries[0], {
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

test('ProviderTrafficArtifactStore appends received line, upserts newest-first index, records failures, and allows later-day session folders', (t) => {
  const rootDir = makeTempDir();
  const legacyFile = path.join(rootDir, 'traffic-2026-05-22.log');
  fs.writeFileSync(legacyFile, '{"legacy":true}\n', 'utf8');

  const store = new ProviderTrafficArtifactStore({ rootDir });
  store.recordRequestStart({
    requestId: 'req-1',
    timestamp: '2026-05-22T09:14:35.044Z',
    provider: 'openai',
    model: 'gpt-5',
    modelClass: 'TimedResponsesWSModel',
    modelWrapperClass: 'FallbackResponsesModel',
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
    modelClass: 'TimedResponsesWSModel',
    modelWrapperClass: 'FallbackResponsesModel',
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
    modelClass: 'TimedOpenAIResponsesWSModel',
    modelWrapperClass: 'FallbackResponsesModel',
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
    modelClass: 'TimedOpenAIResponsesWSModel',
    modelWrapperClass: 'FallbackResponsesModel',
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
    modelClass: 'TimedResponsesWSModel',
    modelWrapperClass: 'FallbackResponsesModel',
    sessionId: 'session-123',
    sessionStartedAt: '2026-05-23T00:00:00.000Z',
    mode: 'standard',
    firstUserMessagePreview: 'resumed later',
    sentBody: { input: [{ role: 'user', content: 'resumed later' }] },
  });

  const requestFile = path.join(rootDir, '2026-05-22', '09-14-31_sessi', '09-14-35.044Z_req-1.jsonl');
  const requestRecords = readRequestFile(requestFile);
  t.is(requestRecords.length, 2);
  t.is(requestRecords[1]?.direction, 'received');
  t.is((requestRecords[1]?.summary as any)?.outputText, 'done');
  t.is(requestRecords[0]?.modelClass, 'TimedResponsesWSModel');
  t.is(requestRecords[0]?.modelWrapperClass, 'FallbackResponsesModel');
  t.is(requestRecords[1]?.modelClass, 'TimedResponsesWSModel');
  t.is(requestRecords[1]?.modelWrapperClass, 'FallbackResponsesModel');

  const failureFile = path.join(rootDir, '2026-05-22', '10-00-00_sessi', '10-00-00.000Z_req-2.jsonl');
  t.is((readRequestFile(failureFile)[1]?.error as any)?.message, 'fetch failed');
  t.is(readRequestFile(failureFile)[0]?.modelClass, 'TimedOpenAIResponsesWSModel');
  t.is(readRequestFile(failureFile)[1]?.modelClass, 'TimedOpenAIResponsesWSModel');

  const indexEntries = fs
    .readFileSync(path.join(rootDir, '2026-05-22', 'index.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  t.is(indexEntries.length, 2);
  t.is(indexEntries[0].sessionId, 'session-999');
  t.is(indexEntries[1].sessionId, 'session-123');
  t.deepEqual(indexEntries[0].providersSeen, ['openrouter']);
  t.deepEqual(indexEntries[1].modelsSeen, ['gpt-5']);

  t.true(fs.existsSync(path.join(rootDir, '2026-05-23', '00-00-00_sessi', '00-00-01.000Z_req-3.jsonl')));
  t.is(fs.readFileSync(legacyFile, 'utf8'), '{"legacy":true}\n');
});

test('ProviderTrafficArtifactStore places evaluator requests under evaluator subfolder', (t) => {
  const rootDir = makeTempDir();
  const store = new ProviderTrafficArtifactStore({ rootDir });

  store.recordRequestStart({
    requestId: 'eval-req-1',
    timestamp: '2026-05-22T09:14:35.044Z',
    provider: 'openai',
    model: 'gpt-4o-mini',
    modelClass: 'CodexResponsesWSModel',
    modelWrapperClass: 'FallbackResponsesModel',
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
    modelWrapperClass: 'FallbackResponsesModel',
    sessionId: 'session-123',
    sessionStartedAt: '2026-05-22T09:14:31.125Z',
    mode: 'standard',
    receivedSummary: { status: 200, outputText: 'approved' },
    evaluator: true,
  });

  const dayDir = path.join(rootDir, '2026-05-22');
  const sessionDir = path.join(dayDir, '09-14-31_sessi');
  const requestFile = path.join(sessionDir, 'evaluator_09-14-35.044Z_eval-.jsonl');

  t.true(fs.existsSync(dayDir));
  t.true(fs.existsSync(sessionDir));
  t.true(fs.existsSync(requestFile));

  const records = readRequestFile(requestFile);
  t.is(records.length, 2);
  t.is(records[0]?.direction, 'sent');
  t.is(records[1]?.direction, 'received');
  t.is(records[0]?.modelClass, 'CodexResponsesWSModel');
  t.is(records[1]?.modelClass, 'CodexResponsesWSModel');
});

test('recordRequestComplete removes completed request path from map so a second completion without a fresh start gets a new path', (t) => {
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

  // The file created by recordRequestStart holds sent + first received (2 records)
  const startFile = path.join(sessionDir, '10-00-01.000Z_test-.jsonl');
  t.true(fs.existsSync(startFile), 'start file should exist');
  t.is(readRequestFile(startFile).length, 2, 'start file should have sent + first received');

  // The second completion MUST write to a NEW file, not reuse the stored path
  const secondFile = path.join(sessionDir, '10-00-10.000Z_test-.jsonl');
  t.true(fs.existsSync(secondFile), 'second completion must create a new file, not reuse the old one');
  const secondRecords = readRequestFile(secondFile);
  t.is(secondRecords.length, 1, 'new file should have exactly one received record');
  t.is(secondRecords[0]?.timestamp, '2026-06-01T10:00:10.000Z');
});
