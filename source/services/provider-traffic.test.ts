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

test('ProviderTrafficArtifactStore writes per-day per-session request files and daily index', (t) => {
  const rootDir = makeTempDir();
  const store = new ProviderTrafficArtifactStore({ rootDir });

  store.recordRequestStart({
    requestId: 'req-1',
    timestamp: '2026-05-22T09:14:35.044Z',
    provider: 'openrouter',
    model: 'qwen/qwen3',
    sessionId: 'session-123',
    sessionStartedAt: '2026-05-22T09:14:31.125Z',
    mode: 'standard',
    firstUserMessagePreview: 'hello there',
    sentBody: { messages: [{ role: 'user', content: 'hello there' }] },
  });

  const dayDir = path.join(rootDir, '2026-05-22');
  const requestFile = path.join(dayDir, '09-14-35.044Z_sess-session-123_req-req-1.jsonl');

  t.true(fs.existsSync(dayDir));
  t.true(fs.existsSync(requestFile));

  t.is(readRequestFile(requestFile)[0]?.direction, 'sent');

  const indexPath = path.join(dayDir, 'index.jsonl');
  const indexEntries = fs
    .readFileSync(indexPath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  t.is(indexEntries.length, 1);
  t.like(indexEntries[0], {
    sessionId: 'session-123',
    sessionDir: '2026-05-22T09-14-31.125Z_session-123',
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
    sessionId: 'session-123',
    sessionStartedAt: '2026-05-23T00:00:00.000Z',
    mode: 'standard',
    firstUserMessagePreview: 'resumed later',
    sentBody: { input: [{ role: 'user', content: 'resumed later' }] },
  });

  const requestFile = path.join(rootDir, '2026-05-22', '09-14-35.044Z_sess-session-123_req-req-1.jsonl');
  const requestRecords = readRequestFile(requestFile);
  t.is(requestRecords.length, 2);
  t.is(requestRecords[1]?.direction, 'received');
  t.is((requestRecords[1]?.summary as any)?.outputText, 'done');

  const failureFile = path.join(rootDir, '2026-05-22', '10-00-00.000Z_sess-session-999_req-req-2.jsonl');
  t.is((readRequestFile(failureFile)[1]?.error as any)?.message, 'fetch failed');

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

  t.true(fs.existsSync(path.join(rootDir, '2026-05-23', '00-00-01.000Z_sess-session-123_req-req-3.jsonl')));
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
    sessionId: 'session-123',
    sessionStartedAt: '2026-05-22T09:14:31.125Z',
    mode: 'standard',
    receivedSummary: { status: 200, outputText: 'approved' },
    evaluator: true,
  });

  const dayDir = path.join(rootDir, '2026-05-22');
  const requestFile = path.join(dayDir, 'evaluator_09-14-35.044Z_sess-session-123_req-eval-req-1.jsonl');

  t.true(fs.existsSync(dayDir));
  t.true(fs.existsSync(requestFile));

  const records = readRequestFile(requestFile);
  t.is(records.length, 2);
  t.is(records[0]?.direction, 'sent');
  t.is(records[1]?.direction, 'received');
});
