import test from 'ava';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { extractProviderTrafficFromLogContent, writeProviderTrafficFiles } from './provider-traffic-extractor.js';

test('extractProviderTrafficFromLogContent extracts sent and received provider payloads', (t) => {
  const content = [
    JSON.stringify({
      timestamp: '2026-02-09 11:42:33',
      traceId: 'trace-a',
      message: 'OpenRouter stream start',
      provider: 'openrouter',
      model: 'moonshotai/kimi-k2.5',
      messageCount: 2,
      messages: [{ role: 'system' }, { role: 'user' }],
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
  t.is(records.length, 2);

  t.is(records[0].direction, 'sent');
  t.is(records[0].traceId, 'trace-a');
  t.deepEqual(records[0].payload.messages, [{ role: 'system' }, { role: 'user' }]);

  t.is(records[1].direction, 'received');
  t.is(records[1].sourceMessage, 'OpenRouter stream done');
  t.is(records[1].payload.text, 'Hello');
});

test.serial('writeProviderTrafficFiles writes per-trace sent/received files and index', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'term2-provider-traffic-'));
  t.teardown(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

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

  const result = await writeProviderTrafficFiles(records, tempDir);
  t.is(result.traces, 1);
  t.is(result.files, 2);

  const indexRaw = await fs.readFile(path.join(tempDir, 'index.json'), 'utf8');
  const index = JSON.parse(indexRaw);
  t.is(index.traces, 1);
  t.is(index.files, 2);
  t.deepEqual(index.index[0].files, ['trace-1/001-sent.json', 'trace-1/002-received.json']);

  const sentRaw = await fs.readFile(path.join(tempDir, 'trace-1', '001-sent.json'), 'utf8');
  const sent = JSON.parse(sentRaw);
  t.is(sent.direction, 'sent');
  t.deepEqual(sent.payload, { messages: [{ role: 'user', content: 'hello' }] });

  const receivedRaw = await fs.readFile(path.join(tempDir, 'trace-1', '002-received.json'), 'utf8');
  const received = JSON.parse(receivedRaw);
  t.is(received.direction, 'received');
  t.deepEqual(received.payload, { text: 'hi' });
});
