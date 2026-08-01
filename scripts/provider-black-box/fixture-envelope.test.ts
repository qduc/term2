import { describe, expect, it } from 'vitest';
import { parseFixtureEnvelope, validateFixtureEnvelope, type FixtureEnvelopeV1 } from './fixture-envelope.js';

const base: FixtureEnvelopeV1 = {
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
        { seq: 0, kind: 'http-request', method: 'POST', urlPath: '/v1', headers: {}, body: { response_id: '<1>' } },
        { seq: 1, kind: 'http-response-head', status: 200, headers: {} },
        { seq: 2, kind: 'sse-event', event: 'response.completed', data: '{"id":"<1>"}' },
        { seq: 3, kind: 'json-body', body: { ok: true } },
        { seq: 4, kind: 'ws-message', direction: 'send', data: { id: '<1>' } },
      ],
    },
  ],
  placeholders: { resp_real: '<1>' },
};

describe('fixture envelope', () => {
  it('validates all frame kinds and cross-frame placeholders', () =>
    expect(validateFixtureEnvelope(base)).toEqual(base));
  it('parses JSON envelopes', () => expect(parseFixtureEnvelope(JSON.stringify(base)).provider).toBe('fixture'));
  it('rejects placeholder collisions', () => {
    expect(() => validateFixtureEnvelope({ ...base, placeholders: { a: '<1>', b: '<1>' } })).toThrow(/collision/i);
  });
  it('rejects unmapped placeholder references', () => {
    expect(() =>
      validateFixtureEnvelope({
        ...base,
        turns: [{ frames: [{ ...base.turns[0]!.frames[0]!, body: { id: '<missing>' } }] }],
      }),
    ).toThrow(/unmapped/i);
  });
  it('rejects non-monotonic frame order', () => {
    expect(() =>
      validateFixtureEnvelope({ ...base, turns: [{ frames: [base.turns[0]!.frames[1]!, base.turns[0]!.frames[0]!] }] }),
    ).toThrow(/increase/i);
  });
});
