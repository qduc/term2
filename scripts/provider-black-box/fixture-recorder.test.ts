import { describe, expect, it } from 'vitest';
import { createFixtureRecorder, parseSseEvents } from './fixture-recorder.js';
import { createRecordingMiddleware } from './fixture-recorder.js';

const metadata = {
  provider: 'fixture',
  wireFamily: 'openai-chat' as const,
  transport: 'http-sse' as const,
  capture: {
    sdkPackage: 'fixture',
    apiSdkVersion: '1.0.0',
    model: 'fixture',
    modelFamily: 'fixture',
    capturedAt: '2026-01-01T00:00:00.000Z',
    recorderVersion: '1',
    probeScenario: 'test',
  },
};

describe('fixture recorder', () => {
  it('parses logical SSE events, including multiline data and DONE', () => {
    expect(parseSseEvents('event: message\ndata: {"a":\ndata: 1}\n\ndata: [DONE]\n\n')).toEqual([
      { event: 'message', data: '{"a":\n1}' },
      { data: '[DONE]' },
    ]);
  });
  it('captures request, response head, and response events without consuming response', async () => {
    const recorder = createFixtureRecorder(metadata);
    const fetch = createRecordingMiddleware({ recorder });
    const response = await fetch(
      {
        url: 'https://fixture.test/v1',
        init: {
          method: 'POST',
          headers: { authorization: 'secret', 'content-type': 'application/json' },
          body: '{"x":1}',
        },
      },
      async () =>
        new Response('data: {"ok":true}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }),
    );
    expect(await response.text()).toContain('[DONE]');
    const envelope = await recorder.flush();
    expect(envelope.turns[0]!.frames.map((frame) => frame.kind)).toEqual([
      'http-request',
      'http-response-head',
      'sse-event',
      'sse-event',
    ]);
    expect((envelope.turns[0]!.frames[0] as any).headers.authorization).toBe('[REDACTED]');
  });
});
