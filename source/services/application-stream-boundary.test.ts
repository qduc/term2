import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';

const canonicalConsumers = [
  'source/services/stream-event-processor.ts',
  'source/services/session/session-stream-processor.ts',
  'source/services/agent-stream.ts',
];

it('keeps legacy runner envelope parsing at the adapter seam', async () => {
  const sources = await Promise.all(canonicalConsumers.map((file) => readFile(file, 'utf8')));
  for (const source of sources) {
    expect(source).not.toMatch(/raw_model_stream_event|run_item_stream_event/);
    expect(source).not.toMatch(/data\??\.event|event\??\.event/);
  }
});
