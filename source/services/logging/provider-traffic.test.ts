import { it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  sanitizeSentTrafficBody,
  summarizeReceivedTraffic,
  ProviderTrafficArtifactStore,
  ProviderTraffic,
  TRAFFIC_TEXT_LIMIT,
  type DailySessionIndexEntry,
} from './provider-traffic.js';
import { NULL_SESSION_CONTEXT_SERVICE } from '../session/session-context-service.js';

const tempDirs: string[] = [];
const makeTempDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-provider-traffic-'));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of tempDirs) {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  tempDirs.length = 0;
});

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

it('sanitizeSentTrafficBody summarizes Responses Lite additional_tools input items', () => {
  const body = {
    input: [
      {
        type: 'additional_tools',
        role: 'developer',
        tools: [
          {
            type: 'function',
            name: 'shell',
            parameters: { type: 'object', properties: { command: { type: 'string' } } },
          },
          {
            type: 'function',
            name: 'apply_patch',
            parameters: { type: 'object', properties: { patch: { type: 'string' } } },
          },
        ],
      },
    ],
  };

  const sanitized = sanitizeSentTrafficBody(body);

  expect(sanitized.input).toEqual([
    {
      type: 'additional_tools',
      role: 'developer',
      tools: ['shell', 'apply_patch'],
    },
  ]);
});

it('sanitizeSentTrafficBody truncates Responses Lite developer input_text instructions', () => {
  const longText = 'd'.repeat(1200);
  const body = {
    input: [
      {
        type: 'message',
        role: 'developer',
        content: [{ type: 'input_text', text: longText }],
      },
    ],
  };

  const sanitized = sanitizeSentTrafficBody(body);
  const input = sanitized.input as Array<Record<string, unknown>>;
  const content = input[0].content as Array<Record<string, unknown>>;

  expect(String(content[0].text).startsWith('d'.repeat(TRAFFIC_TEXT_LIMIT))).toBe(true);
  expect(String(content[0].text).includes(expectedTruncation(longText.length))).toBe(true);
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

// Step 2 of docs/plans/openai-context-compaction.md: encrypted_content must never
// reach a log. openai-responses-model.ts sets `include: ['reasoning.encrypted_content']`
// on every request, so a Responses-API-shaped `type: 'reasoning'` input item carries
// `encrypted_content` directly (not nested under `reasoning_details`, which is the
// Chat-Completions shape the test above covers). A `type: 'compaction'`/`provider_opaque`
// item (Step 1/2's opaque lane) carries it the same way once Step 3/4 send one on the wire.
it('sanitizeSentTrafficBody redacts encrypted_content on Responses-API input items (reasoning and provider_opaque/compaction)', () => {
  const body = {
    input: [
      { role: 'user', content: 'keep me' },
      { type: 'reasoning', id: 'r1', encrypted_content: 'reasoning-ciphertext', summary: [] },
      { type: 'compaction', id: 'c1', encrypted_content: 'compaction-ciphertext', created_by: 'model' },
    ],
  };

  const sanitized = sanitizeSentTrafficBody(body);
  const input = sanitized.input as Array<Record<string, unknown>>;

  expect(input[0]).toEqual({ role: 'user', content: 'keep me' });
  expect(input[1]).toMatchObject({ type: 'reasoning', id: 'r1', summary: [] });
  expect(input[1].encrypted_content).not.toBe('reasoning-ciphertext');
  expect(input[2]).toMatchObject({ type: 'compaction', id: 'c1', created_by: 'model' });
  expect(input[2].encrypted_content).not.toBe('compaction-ciphertext');

  const serialized = JSON.stringify(sanitized);
  expect(serialized).not.toContain('reasoning-ciphertext');
  expect(serialized).not.toContain('compaction-ciphertext');
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

// Step 2 of docs/plans/openai-context-compaction.md: a non-streaming JSON response's
// `output` array can contain reasoning items (encrypted_content is requested on every
// OpenAI Responses call, not just compaction turns) and, once Step 3/4 land, compaction
// items — both carry `encrypted_content` directly. The JSON-transport branch of
// summarizeReceivedTraffic stores `parsed` as `summary.payload` verbatim; this is what
// both the winston debug log (ProviderTraffic.recordResponseReceived) and the on-disk
// provider-traffic artifact file receive, so it must be redacted here.
it('summarizeReceivedTraffic redacts encrypted_content from reasoning and compaction output items', async () => {
  const summary = await summarizeReceivedTraffic(
    new Response(
      JSON.stringify({
        id: 'resp_1',
        output: [
          { type: 'reasoning', id: 'r1', encrypted_content: 'reasoning-ciphertext', summary: [] },
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done' }] },
          { type: 'compaction', id: 'c1', encrypted_content: 'compaction-ciphertext', created_by: 'model' },
        ],
        usage: { input_tokens: 3, output_tokens: 2 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ),
  );

  expect(summary.transport).toBe('json');
  const serialized = JSON.stringify(summary.payload);
  expect(serialized).not.toContain('reasoning-ciphertext');
  expect(serialized).not.toContain('compaction-ciphertext');
  // Everything else about the response is preserved verbatim.
  expect((summary.payload as any)?.id).toBe('resp_1');
  expect((summary.payload as any)?.output?.[1]).toEqual({
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text: 'Done' }],
  });
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
  const requestFile = path.join(sessionDir, '09-14-35.044Z_req-1.json');

  expect(fs.existsSync(dayDir)).toBe(true);
  expect(fs.existsSync(sessionDir)).toBe(true);
  expect(fs.existsSync(requestFile)).toBe(true);
  expect(path.basename(requestFile)).toBe('09-14-35.044Z_req-1.json');
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

  const requestFile = path.join(rootDir, '2026-05-22', '09-14-31_sessi', '09-14-35.044Z_req-1.json');
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

  const failureFile = path.join(rootDir, '2026-05-22', '10-00-00_sessi', '10-00-00.000Z_req-2.json');
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

  expect(fs.existsSync(path.join(rootDir, '2026-05-23', '00-00-00_sessi', '00-00-01.000Z_req-3.json'))).toBe(true);
  expect(fs.readFileSync(legacyFile, 'utf8')).toBe('{"legacy":true}\n');
});

it('ProviderTrafficArtifactStore places evaluator requests with evaluator_ filename prefix', () => {
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
  const requestFile = path.join(sessionDir, 'evaluator_09-14-35.044Z_eval-.json');

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
  const startFile = path.join(sessionDir, '10-00-01.000Z_test-.json');
  expect(fs.existsSync(startFile)).toBe(true);
  expect((readRequestFile(startFile).sent as Record<string, unknown>)?.direction).toBe('sent');
  expect((readRequestFile(startFile).received as Record<string, unknown>)?.direction).toBe('received');

  // The second completion MUST write to a NEW file, not reuse the stored path
  const secondFile = path.join(sessionDir, '10-00-10.000Z_test-.json');
  expect(fs.existsSync(secondFile)).toBe(true);
  const secondRecords = readRequestFile(secondFile);
  expect((secondRecords.sent as Record<string, unknown>) ?? {}).toEqual({});
  expect((secondRecords.received as Record<string, unknown>)?.timestamp).toBe('2026-06-01T10:00:10.000Z');
});

// Step 2 of docs/plans/openai-context-compaction.md: ProviderTraffic.recordResponseReceived's
// non-Response, non-websocket branch (a provider adapter that resolves directly to a parsed
// object rather than a Fetch Response) stores its payload verbatim too — same leak, same fix.
it('ProviderTraffic.recordResponseReceived redacts encrypted_content from a plain-object response payload', async () => {
  const rootDir = makeTempDir();
  const store = new ProviderTrafficArtifactStore({ rootDir });
  const debug = vi.fn();
  const error = vi.fn();
  const loggingService = { debug, warn: vi.fn(), error, getCorrelationId: () => undefined };
  const traffic = new ProviderTraffic(loggingService, NULL_SESSION_CONTEXT_SERVICE, store);

  const requestId = 'plain-object-req';
  traffic.recordRequestStart({
    requestId,
    provider: 'openai',
    model: 'gpt-5.4',
    sentBody: { input: [{ role: 'user', content: 'hi' }] },
  });

  await traffic.recordResponseReceived({
    requestId,
    provider: 'openai',
    model: 'gpt-5.4',
    status: 200,
    response: {
      id: 'resp_1',
      output: [{ type: 'compaction', id: 'c1', encrypted_content: 'plain-object-ciphertext' }],
    },
  });

  // Nothing passed to the winston debug log contains the ciphertext.
  const loggedText = JSON.stringify(debug.mock.calls);
  expect(loggedText).not.toContain('plain-object-ciphertext');

  // Nor does the on-disk traffic artifact.
  const dayDir = fs.readdirSync(rootDir).find((entry) => /^\d{4}-\d{2}-\d{2}$/.test(entry));
  expect(dayDir).toBeTruthy();
  const sessionDir = fs.readdirSync(path.join(rootDir, dayDir!))[0];
  const requestFiles = fs.readdirSync(path.join(rootDir, dayDir!, sessionDir)).filter((name) => name.endsWith('.json'));
  const artifactText = requestFiles
    .map((name) => fs.readFileSync(path.join(rootDir, dayDir!, sessionDir, name), 'utf8'))
    .join('\n');
  expect(artifactText).not.toContain('plain-object-ciphertext');
});

it('ProviderTraffic records consumer-closed streams as metadata without fabricating a provider failure', () => {
  const rootDir = makeTempDir();
  const store = new ProviderTrafficArtifactStore({ rootDir });
  const debug = vi.fn();
  const error = vi.fn();
  const traffic = new ProviderTraffic(
    { debug, warn: vi.fn(), error, getCorrelationId: () => undefined },
    NULL_SESSION_CONTEXT_SERVICE,
    store,
  );
  const requestId = 'consumer-closed-req';

  traffic.recordRequestStart({ requestId, provider: 'codex', model: 'gpt-5.6-luna', sentBody: { input: [] } });
  traffic.recordResponseClosed({
    requestId,
    provider: 'codex',
    model: 'gpt-5.6-luna',
    outcome: 'consumer_closed',
    eventCount: 2,
  });

  const dayDir = fs.readdirSync(rootDir).find((entry) => /^\d{4}-\d{2}-\d{2}$/.test(entry));
  const sessionDir = fs.readdirSync(path.join(rootDir, dayDir!))[0];
  const requestFile = fs.readdirSync(path.join(rootDir, dayDir!, sessionDir)).find((name) => name.endsWith('.json'))!;
  const received = readRequestFile(path.join(rootDir, dayDir!, sessionDir, requestFile)).received as Record<
    string,
    unknown
  >;

  expect(received).toMatchObject({ direction: 'received', summary: { outcome: 'consumer_closed', eventCount: 2 } });
  expect(received).not.toHaveProperty('error');
  expect(error).not.toHaveBeenCalled();
  expect(debug).toHaveBeenLastCalledWith(
    'codex response closed',
    expect.objectContaining({ eventType: 'provider.response.closed', outcome: 'consumer_closed', eventCount: 2 }),
  );
});

// An aborted stream has no payload to summarize, so its retained transcript is
// the only record of what the model was producing when it was cut off.
it("ProviderTraffic writes an aborted stream's transcript to the artifact and keeps it out of the app log", () => {
  const rootDir = makeTempDir();
  const store = new ProviderTrafficArtifactStore({ rootDir });
  const debug = vi.fn();
  const warn = vi.fn();
  const error = vi.fn();
  const traffic = new ProviderTraffic(
    { debug, warn, error, getCorrelationId: () => undefined },
    NULL_SESSION_CONTEXT_SERVICE,
    store,
  );
  const requestId = 'aborted-req';

  traffic.recordRequestStart({ requestId, provider: 'codex', model: 'gpt-5.6-luna', sentBody: { input: [] } });
  traffic.recordResponseClosed({
    requestId,
    provider: 'codex',
    model: 'gpt-5.6-luna',
    outcome: 'aborted',
    eventCount: 2,
    diagnostics: {
      durationMs: 300_041,
      firstEventMs: 812,
      lastEventMs: 299_988,
      maxGapMs: 1204,
      responseId: 'resp_runaway',
      eventTypeCounts: { 'response.reasoning_summary_text.delta': 2 },
      events: [{ type: 'response.reasoning_summary_text.delta', delta: 'looping forever' }],
    },
  });

  const dayDir = fs.readdirSync(rootDir).find((entry) => /^\d{4}-\d{2}-\d{2}$/.test(entry));
  const sessionDir = fs.readdirSync(path.join(rootDir, dayDir!))[0];
  const requestFile = fs.readdirSync(path.join(rootDir, dayDir!, sessionDir)).find((name) => name.endsWith('.json'))!;
  const received = readRequestFile(path.join(rootDir, dayDir!, sessionDir, requestFile)).received as Record<
    string,
    unknown
  >;

  expect(received.summary).toMatchObject({
    outcome: 'aborted',
    eventCount: 2,
    durationMs: 300_041,
    maxGapMs: 1204,
    responseId: 'resp_runaway',
    eventTypeCounts: { 'response.reasoning_summary_text.delta': 2 },
    events: [{ type: 'response.reasoning_summary_text.delta', delta: 'looping forever' }],
  });

  // An abort is worth noticing, but the transcript would swamp the app log.
  expect(warn).toHaveBeenCalledWith(
    'codex response closed',
    expect.objectContaining({ outcome: 'aborted', durationMs: 300_041, maxGapMs: 1204 }),
  );
  expect(JSON.stringify(warn.mock.calls)).not.toContain('looping forever');
  expect(error).not.toHaveBeenCalled();
});

// A transport-liveness guard that never records its own margin can only be
// calibrated by losing a live turn to a false positive, so the measured
// latencies and the budgets they were judged against are retained per request.
it('ProviderTraffic retains the receive timing of a successful websocket response', async () => {
  const rootDir = makeTempDir();
  const store = new ProviderTrafficArtifactStore({ rootDir });
  const traffic = new ProviderTraffic(
    { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), getCorrelationId: () => undefined },
    NULL_SESSION_CONTEXT_SERVICE,
    store,
  );
  const requestId = 'ws-timing-req';

  traffic.recordRequestStart({ requestId, provider: 'codex', model: 'gpt-5.6-luna', sentBody: { input: [] } });
  await traffic.recordResponseReceived({
    requestId,
    provider: 'codex',
    model: 'gpt-5.6-luna',
    status: 200,
    transport: 'websocket',
    response: { id: 'resp_1', output: [] },
    receiveTiming: {
      frameCount: 41,
      firstFrameMs: 2_318,
      maxInterFrameMs: 4_002,
      firstFrameBudgetMs: 90_000,
      interFrameBudgetMs: 600_000,
    },
  });

  const dayDir = fs.readdirSync(rootDir).find((entry) => /^\d{4}-\d{2}-\d{2}$/.test(entry));
  const sessionDir = fs.readdirSync(path.join(rootDir, dayDir!))[0];
  const requestFile = fs.readdirSync(path.join(rootDir, dayDir!, sessionDir)).find((name) => name.endsWith('.json'))!;
  const received = readRequestFile(path.join(rootDir, dayDir!, sessionDir, requestFile)).received as Record<
    string,
    unknown
  >;

  expect((received.summary as Record<string, unknown>).receiveTiming).toEqual({
    frameCount: 41,
    firstFrameMs: 2_318,
    maxInterFrameMs: 4_002,
    firstFrameBudgetMs: 90_000,
    interFrameBudgetMs: 600_000,
  });
});

it('ProviderTraffic retains the receive timing of a failed websocket request', () => {
  const rootDir = makeTempDir();
  const store = new ProviderTrafficArtifactStore({ rootDir });
  const traffic = new ProviderTraffic(
    { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), getCorrelationId: () => undefined },
    NULL_SESSION_CONTEXT_SERVICE,
    store,
  );
  const requestId = 'ws-timeout-req';

  traffic.recordRequestStart({ requestId, provider: 'codex', model: 'gpt-5.6-luna', sentBody: { input: [] } });
  traffic.recordRequestFailed({
    requestId,
    provider: 'codex',
    model: 'gpt-5.6-luna',
    error: new Error('WebSocket first frame timeout'),
    receiveTiming: {
      frameCount: 0,
      waitedMs: 90_000,
      firstFrameBudgetMs: 90_000,
      interFrameBudgetMs: 600_000,
    },
  });

  const dayDir = fs.readdirSync(rootDir).find((entry) => /^\d{4}-\d{2}-\d{2}$/.test(entry));
  const sessionDir = fs.readdirSync(path.join(rootDir, dayDir!))[0];
  const requestFile = fs.readdirSync(path.join(rootDir, dayDir!, sessionDir)).find((name) => name.endsWith('.json'))!;
  const received = readRequestFile(path.join(rootDir, dayDir!, sessionDir, requestFile)).received as Record<
    string,
    unknown
  >;

  expect(received.error).toMatchObject({
    message: 'WebSocket first frame timeout',
    receiveTiming: {
      frameCount: 0,
      waitedMs: 90_000,
      firstFrameBudgetMs: 90_000,
      interFrameBudgetMs: 600_000,
    },
  });
});

// --- Contract 07 Diagnostic Logging Safety & Fault Tolerance Characterizations ---

class ThrowingStore extends ProviderTrafficArtifactStore {
  override recordRequestStart(): void {
    throw new Error('Simulated store write error: ENOSPC');
  }
  override recordRequestComplete(): void {
    throw new Error('Simulated store write error: ENOSPC');
  }
}

type WarningRecord = { message: string; meta?: Record<string, unknown> };

it('ProviderTraffic.recordRequestStart does not throw when artifact store fails', () => {
  const warnings: WarningRecord[] = [];
  const store = new ThrowingStore({ rootDir: '/fake/root' });
  const traffic = new ProviderTraffic(
    {
      debug: vi.fn(),
      warn: vi.fn((message: string, meta?: Record<string, unknown>) => {
        warnings.push({ message, meta });
      }),
      error: vi.fn(),
      getCorrelationId: () => undefined,
    },
    NULL_SESSION_CONTEXT_SERVICE,
    store,
  );

  expect(() => {
    traffic.recordRequestStart({
      requestId: 'req-fail-proof-1',
      provider: 'openai',
      model: 'gpt-4o',
      sentBody: { messages: [{ role: 'user', content: 'hello' }] },
    });
  }).not.toThrow();

  expect(warnings).toHaveLength(1);
  expect(warnings[0].meta?.eventType).toBe('provider.traffic.artifact_write_failed');
  expect(warnings[0].meta?.requestId).toBe('req-fail-proof-1');
});

it('ProviderTraffic.recordResponseReceived does not reject when artifact store fails', async () => {
  const warnings: WarningRecord[] = [];
  const store = new ThrowingStore({ rootDir: '/fake/root' });
  const traffic = new ProviderTraffic(
    {
      debug: vi.fn(),
      warn: vi.fn((message: string, meta?: Record<string, unknown>) => {
        warnings.push({ message, meta });
      }),
      error: vi.fn(),
      getCorrelationId: () => undefined,
    },
    NULL_SESSION_CONTEXT_SERVICE,
    store,
  );

  await expect(
    traffic.recordResponseReceived({
      requestId: 'req-fail-proof-2',
      provider: 'openai',
      model: 'gpt-4o',
      status: 200,
      response: { choices: [{ message: { content: 'hello world' } }] },
    }),
  ).resolves.toBeUndefined();

  expect(warnings).toHaveLength(1);
  expect(warnings[0].meta?.eventType).toBe('provider.traffic.artifact_write_failed');
  expect(warnings[0].meta?.requestId).toBe('req-fail-proof-2');
});

it('ProviderTraffic.recordResponseClosed does not throw when artifact store fails', () => {
  const warnings: WarningRecord[] = [];
  const store = new ThrowingStore({ rootDir: '/fake/root' });
  const traffic = new ProviderTraffic(
    {
      debug: vi.fn(),
      warn: vi.fn((message: string, meta?: Record<string, unknown>) => {
        warnings.push({ message, meta });
      }),
      error: vi.fn(),
      getCorrelationId: () => undefined,
    },
    NULL_SESSION_CONTEXT_SERVICE,
    store,
  );

  expect(() => {
    traffic.recordResponseClosed({
      requestId: 'req-fail-proof-closed',
      provider: 'openai',
      model: 'gpt-4o',
      outcome: 'consumer_closed',
      eventCount: 5,
    });
  }).not.toThrow();

  expect(warnings).toHaveLength(1);
  expect(warnings[0].meta?.eventType).toBe('provider.traffic.artifact_write_failed');
  expect(warnings[0].meta?.requestId).toBe('req-fail-proof-closed');
});

it('ProviderTraffic.recordRequestFailed does not throw when artifact store fails', () => {
  const warnings: WarningRecord[] = [];
  const store = new ThrowingStore({ rootDir: '/fake/root' });
  const traffic = new ProviderTraffic(
    {
      debug: vi.fn(),
      warn: vi.fn((message: string, meta?: Record<string, unknown>) => {
        warnings.push({ message, meta });
      }),
      error: vi.fn(),
      getCorrelationId: () => undefined,
    },
    NULL_SESSION_CONTEXT_SERVICE,
    store,
  );

  expect(() => {
    traffic.recordRequestFailed({
      requestId: 'req-fail-proof-3',
      provider: 'anthropic',
      model: 'claude-3-5-sonnet',
      error: new Error('Upstream timeout 504'),
    });
  }).not.toThrow();

  expect(warnings).toHaveLength(1);
  expect(warnings[0].meta?.eventType).toBe('provider.traffic.artifact_write_failed');
  expect(warnings[0].meta?.requestId).toBe('req-fail-proof-3');
});

it('ProviderTrafficArtifactStore ignores malformed lines in daily index.jsonl without crashing', () => {
  const rootDir = makeTempDir();
  const dateKey = '2026-08-15';
  const dayDir = path.join(rootDir, dateKey);

  fs.mkdirSync(dayDir, { recursive: true });
  const validEntry: DailySessionIndexEntry = {
    sessionId: 'session-valid-1',
    sessionDir: '10-00-00_sessi',
    firstRequestAt: '2026-08-15T10:00:00.000Z',
    lastRequestAt: '2026-08-15T10:00:00.000Z',
    requestCount: 1,
    firstUserMessagePreview: 'hello',
    latestProvider: 'openai',
    latestModel: 'gpt-4o',
    providersSeen: ['openai'],
    modelsSeen: ['gpt-4o'],
    latestMode: 'code',
    modesSeen: ['code'],
  };

  // Seed one valid line and one malformed line
  fs.writeFileSync(path.join(dayDir, 'index.jsonl'), `${JSON.stringify(validEntry)}\n{CORRUPTED_JSON_LINE\n`, 'utf8');

  const store = new ProviderTrafficArtifactStore({ rootDir });

  expect(() => {
    store.recordRequestStart({
      requestId: 'req-new-1',
      timestamp: '2026-08-15T10:05:00.000Z',
      provider: 'openai',
      model: 'gpt-4o',
      sessionId: 'session-new-2',
      sessionStartedAt: '2026-08-15T10:05:00.000Z',
      sentBody: {},
    });
  }).not.toThrow();

  const lines = fs
    .readFileSync(path.join(dayDir, 'index.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.trim());
  const parsed: DailySessionIndexEntry[] = lines.map((l) => JSON.parse(l));
  expect(parsed.some((entry) => entry.sessionId === 'session-valid-1')).toBe(true);
  expect(parsed.some((entry) => entry.sessionId === 'session-new-2')).toBe(true);

  // Positively assert the new request artifact file exists with truncated requestId suffix (_req-n.json)
  const sessionDir = path.join(dayDir, '10-05-00_sessi');
  const requestFiles = fs.existsSync(sessionDir) ? fs.readdirSync(sessionDir) : [];
  expect(requestFiles.some((f) => f.endsWith('_req-n.json'))).toBe(true);
});

// --- Contract 07 Bounded request-path lifecycle ---
//
// `ProviderTrafficArtifactStore.#requestPaths` maps requestId -> artifact path
// so `recordRequestComplete` can rewrite the envelope the start created.
// Completion is the selected owner cleanup path (proven above by
// 'recordRequestComplete removes completed request path from map...'). These
// proofs pin the failure-side of that lifecycle: a start or completion that
// fails part-way must release the correlation entry rather than leak it for
// the life of the process, while entries for live in-flight requests stay
// (that is the non-discard half of the decision).

it('ProviderTrafficArtifactStore releases a request path when recordRequestStart fails part-way', () => {
  const rootDir = makeTempDir();
  const dayDir = path.join(rootDir, '2026-06-02');
  fs.mkdirSync(dayDir, { recursive: true });
  // The daily index is a directory, so the start writes its envelope (mkdir +
  // file succeed) and then fails during the index upsert/read.
  fs.mkdirSync(path.join(dayDir, 'index.jsonl'));

  const store = new ProviderTrafficArtifactStore({ rootDir });
  const requestId = 'leak-check-req';
  const startedAt = '2026-06-02T10:00:00.000Z';

  expect(() => {
    store.recordRequestStart({
      requestId,
      timestamp: '2026-06-02T10:00:01.000Z',
      provider: 'openai',
      model: 'gpt-4o',
      sessionId: 'session-leak',
      sessionStartedAt: startedAt,
      mode: 'standard',
      sentBody: { messages: [{ role: 'user', content: 'hello' }] },
    });
  }).toThrow();

  // Unblock the index so a later completion can land.
  fs.rmdirSync(path.join(dayDir, 'index.jsonl'));

  // If the failed start had retained its correlation entry, this completion
  // would reuse the stale start path; a released entry falls back to #pathsFor
  // and writes a fresh artifact keyed by the completion timestamp.
  store.recordRequestComplete({
    requestId,
    timestamp: '2026-06-02T10:00:05.000Z',
    provider: 'openai',
    model: 'gpt-4o',
    sessionId: 'session-leak',
    sessionStartedAt: startedAt,
    mode: 'standard',
    receivedSummary: { status: 200 },
  });

  const sessionDir = path.join(dayDir, '10-00-00_sessi');
  const completeFile = path.join(sessionDir, '10-00-05.000Z_leak-.json');
  expect(fs.existsSync(completeFile)).toBe(true);

  // The partial start artifact must not have been touched by the completion.
  const startFile = path.join(sessionDir, '10-00-01.000Z_leak-.json');
  const startRecords = readRequestFile(startFile);
  expect((startRecords.sent as Record<string, unknown>)?.direction).toBe('sent');
  expect((startRecords.received as Record<string, unknown>) ?? {}).toEqual({});
});

it('ProviderTrafficArtifactStore releases a request path when recordRequestComplete fails part-way', () => {
  const rootDir = makeTempDir();
  const dayDir = path.join(rootDir, '2026-06-03');
  const store = new ProviderTrafficArtifactStore({ rootDir });
  const requestId = 'complete-leak-req';
  const startedAt = '2026-06-03T11:00:00.000Z';

  store.recordRequestStart({
    requestId,
    timestamp: '2026-06-03T11:00:01.000Z',
    provider: 'openai',
    model: 'gpt-4o',
    sessionId: 'session-complete-leak',
    sessionStartedAt: startedAt,
    mode: 'standard',
    sentBody: { messages: [{ role: 'user', content: 'hello' }] },
  });

  const sessionDir = path.join(dayDir, '11-00-00_sessi');
  const startFile = path.join(sessionDir, '11-00-01.000Z_compl.json');

  // Turn the start artifact into a directory so the completion's envelope read
  // throws (EISDIR) before any write: the entry must still be released.
  fs.rmSync(startFile, { force: true });
  fs.mkdirSync(startFile, { recursive: true });

  expect(() => {
    store.recordRequestComplete({
      requestId,
      timestamp: '2026-06-03T11:00:05.000Z',
      provider: 'openai',
      model: 'gpt-4o',
      sessionId: 'session-complete-leak',
      sessionStartedAt: startedAt,
      mode: 'standard',
      receivedSummary: { status: 200 },
    });
  }).toThrow();

  // Restore the artifact path to a normal file so a second completion can land.
  fs.rmdirSync(startFile);

  // If the failed completion had retained its correlation entry, this second
  // completion would rewrite the stale start path; a released entry falls back
  // to #pathsFor and writes a fresh artifact keyed by this timestamp.
  store.recordRequestComplete({
    requestId,
    timestamp: '2026-06-03T11:00:10.000Z',
    provider: 'openai',
    model: 'gpt-4o',
    sessionId: 'session-complete-leak',
    sessionStartedAt: startedAt,
    mode: 'standard',
    receivedSummary: { status: 200 },
  });

  const secondFile = path.join(sessionDir, '11-00-10.000Z_compl.json');
  expect(fs.existsSync(secondFile)).toBe(true);
  const secondRecords = readRequestFile(secondFile);
  expect((secondRecords.sent as Record<string, unknown>) ?? {}).toEqual({});
  expect((secondRecords.received as Record<string, unknown>)?.timestamp).toBe('2026-06-03T11:00:10.000Z');
});
