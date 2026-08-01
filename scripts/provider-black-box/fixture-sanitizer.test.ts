import { describe, expect, it } from 'vitest';
import { sanitizeFixtureEnvelope, scanFixtureSecrets } from './fixture-sanitizer.js';
import type { FixtureEnvelopeV1 } from './fixture-envelope.js';

const envelope: FixtureEnvelopeV1 = {
  schemaVersion: 1,
  kind: 'real-traffic-recording',
  provider: 'fixture',
  wireFamily: 'openai-chat',
  transport: 'http-sse',
  capture: {
    sdkPackage: 'fixture',
    apiSdkVersion: '1.0.0',
    model: 'fixture',
    modelFamily: 'fixture',
    capturedAt: '2026-01-01T00:00:00.000Z',
    recorderVersion: '1',
    probeScenario: 'test',
  },
  turns: [
    {
      frames: [
        {
          seq: 0,
          kind: 'http-request',
          method: 'POST',
          urlPath: '/v1',
          headers: { authorization: 'Bearer secret' },
          body: { api_key: 'sk-secret' },
        },
        { seq: 1, kind: 'sse-event', data: '{"id":"resp_live","call_id":"call_live","output":"safe"}' },
      ],
    },
  ],
  placeholders: {},
};

describe('fixture sanitizer', () => {
  it('redacts request secrets and canonicalizes IDs inside response payloads', () => {
    const result = sanitizeFixtureEnvelope(envelope);
    expect(result.envelope.turns[0]!.frames[0]).toMatchObject({
      headers: { authorization: '[REDACTED]' },
      body: { api_key: '[REDACTED]' },
    });
    const response = result.envelope.turns[0]!.frames[1];
    expect(response.kind === 'sse-event' && response.data).toContain('<1>');
    expect(Object.keys(result.report.placeholders)).toEqual(['resp_live', 'call_live']);
    expect(scanFixtureSecrets(result.envelope).safe).toBe(true);
  });
});
