import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { extractProviderTrafficFromLogContent, writeProviderTrafficFiles } from './provider-traffic-extractor.js';

it('extractProviderTrafficFromLogContent extracts sent and received provider payloads', () => {
  const content = [
    JSON.stringify({
      timestamp: '2026-02-09 11:42:33',
      traceId: 'trace-a',
      message: 'OpenRouter stream start',
      provider: 'openrouter',
      model: 'moonshotai/kimi-k2.5',
      messageCount: 2,
      messages: [{ role: 'system' }, { role: 'user' }],
      headers: { 'x-opencode-session': 'session-xyz', authorization: '[REDACTED]' },
    }),
    JSON.stringify({
      timestamp: '2026-02-09 11:42:37',
      traceId: 'trace-a',
      message: 'OpenRouter stream done',
      provider: 'openrouter',
      model: 'moonshotai/kimi-k2.5',
      text: 'Hello',
      reasoningDetails: [{ type: 'reasoning.text' }],
    }),
    JSON.stringify({
      message: 'some other event',
      traceId: 'trace-a',
    }),
  ].join('\n');

  const records = extractProviderTrafficFromLogContent(content);
  expect(records.length).toBe(2);

  expect(records[0].direction).toBe('sent');
  expect(records[0].traceId).toBe('trace-a');
  expect(records[0].payload.messages).toEqual([{ role: 'system' }, { role: 'user' }]);
  expect(records[0].headers).toEqual({ 'x-opencode-session': 'session-xyz', authorization: '[REDACTED]' });

  expect(records[1].direction).toBe('received');
  expect(records[1].sourceMessage).toBe('OpenRouter stream done');
  expect(records[1].payload.text).toBe('Hello');
});

it.sequential('writeProviderTrafficFiles writes per-trace sent/received files and index', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'term2-provider-traffic-'));

  const records = [
    {
      traceId: 'trace-1',
      lineNumber: 10,
      timestamp: '2026-02-09 11:00:00',
      direction: 'sent' as const,
      sourceMessage: 'OpenRouter stream start',
      provider: 'openrouter',
      model: 'model-a',
      payload: { messages: [{ role: 'user', content: 'hello' }] },
    },
    {
      traceId: 'trace-1',
      lineNumber: 15,
      timestamp: '2026-02-09 11:00:02',
      direction: 'received' as const,
      sourceMessage: 'OpenRouter stream done',
      provider: 'openrouter',
      model: 'model-a',
      payload: { text: 'hi' },
    },
  ];

  try {
    const result = await writeProviderTrafficFiles(records, tempDir);
    expect(result.traces).toBe(1);
    expect(result.files).toBe(2);

    const indexRaw = await fs.readFile(path.join(tempDir, 'index.json'), 'utf8');
    const index = JSON.parse(indexRaw);
    expect(index.traces).toBe(1);
    expect(index.files).toBe(2);
    expect(index.index[0].files).toEqual(['trace-1/001-sent.json', 'trace-1/002-received.json']);

    const sentRaw = await fs.readFile(path.join(tempDir, 'trace-1', '001-sent.json'), 'utf8');
    const sent = JSON.parse(sentRaw);
    expect(sent.direction).toBe('sent');
    expect(sent.payload).toEqual({ messages: [{ role: 'user', content: 'hello' }] });

    const receivedRaw = await fs.readFile(path.join(tempDir, 'trace-1', '002-received.json'), 'utf8');
    const received = JSON.parse(receivedRaw);
    expect(received.direction).toBe('received');
    expect(received.payload).toEqual({ text: 'hi' });
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
