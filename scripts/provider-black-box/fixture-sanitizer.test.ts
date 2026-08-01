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
          headers: { authorization: 'Bearer secret', 'x-opencode-session': 'ses_capture-session-id' },
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
      headers: { authorization: '[REDACTED]', 'x-opencode-session': '[REDACTED]' },
      body: { api_key: '[REDACTED]' },
    });
    const response = result.envelope.turns[0]!.frames[1];
    expect(response.kind === 'sse-event' && response.data).toContain('<1>');
    expect(Object.keys(result.report.placeholders)).toEqual(['resp_live', 'call_live']);
    expect(scanFixtureSecrets(result.envelope).safe).toBe(true);
  });

  it('redacts plaintext model reasoning while preserving response protocol structure', () => {
    const result = sanitizeFixtureEnvelope({
      ...envelope,
      turns: [
        {
          frames: [
            {
              seq: 0,
              kind: 'sse-event',
              data: JSON.stringify({
                choices: [
                  {
                    delta: {
                      reasoning: 'private chain of thought',
                      reasoning_details: [{ type: 'reasoning.text', text: 'private detail' }],
                    },
                  },
                ],
              }),
            },
          ],
        },
      ],
    });
    const data = result.envelope.turns[0]!.frames[0];
    expect(data.kind === 'sse-event' && data.data).not.toContain('private');
    expect(data.kind === 'sse-event' && data.data).toContain('[REDACTED]');
    expect(scanFixtureSecrets(result.envelope).safe).toBe(true);
  });

  it('does not flag relative provider URL paths and redacts opaque thought signatures', () => {
    const result = sanitizeFixtureEnvelope({
      ...envelope,
      turns: [
        {
          frames: [
            {
              seq: 0,
              kind: 'http-request',
              method: 'POST',
              urlPath: '/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse',
              headers: {},
              body: {},
            },
            {
              seq: 1,
              kind: 'sse-event',
              data: JSON.stringify({
                candidates: [{ content: { parts: [{ thoughtSignature: 'CiQBEU0yDwP9+/=' + 'A'.repeat(540) }] } }],
              }),
            },
          ],
        },
      ],
    });
    const data = result.envelope.turns[0]!.frames[1];
    expect(data.kind === 'sse-event' && data.data).toContain('[REDACTED]');
    expect(result.report.redactions.some(({ reason }) => reason === 'opaque provider signature redacted')).toBe(true);
    expect(scanFixtureSecrets(result.envelope).safe).toBe(true);
  });

  it('redacts Google thought text while preserving the thought part shape', () => {
    const result = sanitizeFixtureEnvelope({
      ...envelope,
      turns: [
        {
          frames: [
            {
              seq: 0,
              kind: 'sse-event',
              data: JSON.stringify({
                candidates: [{ content: { parts: [{ thought: true, text: 'private Gemini reasoning' }] } }],
              }),
            },
          ],
        },
      ],
    });
    const data = result.envelope.turns[0]!.frames[0];
    expect(data.kind === 'sse-event' && data.data).not.toContain('private Gemini reasoning');
    expect(data.kind === 'sse-event' && data.data).toContain('"thought":true');
    expect(data.kind === 'sse-event' && data.data).toContain('[REDACTED]');
    expect(scanFixtureSecrets(result.envelope).safe).toBe(true);
  });

  it('redacts Anthropic thinking deltas while preserving event structure', () => {
    const result = sanitizeFixtureEnvelope({
      ...envelope,
      turns: [
        {
          frames: [
            {
              seq: 0,
              kind: 'sse-event',
              data: JSON.stringify({
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'thinking_delta', thinking: 'private Anthropic reasoning' },
              }),
            },
          ],
        },
      ],
    });
    const data = result.envelope.turns[0]!.frames[0];
    expect(data.kind === 'sse-event' && data.data).not.toContain('private Anthropic reasoning');
    expect(data.kind === 'sse-event' && data.data).toContain('"type":"thinking_delta"');
    expect(data.kind === 'sse-event' && data.data).toContain('[REDACTED]');
    expect(scanFixtureSecrets(result.envelope).safe).toBe(true);
  });

  it('redacts chat reasoning deltas and provider fingerprints', () => {
    const result = sanitizeFixtureEnvelope({
      ...envelope,
      turns: [
        {
          frames: [
            {
              seq: 0,
              kind: 'sse-event',
              data: JSON.stringify({
                system_fingerprint: 'fp_a18b46594c_prod0820_fp8_kvcache_20260',
                choices: [{ delta: { reasoning_content: 'private provider reasoning' } }],
              }),
            },
          ],
        },
      ],
    });
    const data = result.envelope.turns[0]!.frames[0];
    expect(data.kind === 'sse-event' && data.data).not.toContain('private provider reasoning');
    expect(data.kind === 'sse-event' && data.data).toContain('"system_fingerprint":"[REDACTED]"');
    expect(scanFixtureSecrets(result.envelope).safe).toBe(true);
  });

  it('redacts provider identifiers in response headers and canonicalizes request IDs', () => {
    const result = sanitizeFixtureEnvelope({
      ...envelope,
      turns: [
        {
          frames: [
            {
              seq: 0,
              kind: 'http-response-head',
              status: 200,
              headers: {
                'openai-organization': 'user-private',
                'openai-project': 'proj_private',
                'x-request-id': 'req_live',
              },
            },
          ],
        },
      ],
    });
    expect(result.envelope.turns[0]!.frames[0]).toMatchObject({
      headers: {
        'openai-organization': '[REDACTED]',
        'openai-project': '[REDACTED]',
        'x-request-id': 'req_<1>',
      },
    });
    expect(scanFixtureSecrets(result.envelope).safe).toBe(true);
  });

  it('canonicalizes Responses reasoning and function item IDs and removes encrypted content', () => {
    const result = sanitizeFixtureEnvelope({
      ...envelope,
      turns: [
        {
          frames: [
            {
              seq: 0,
              kind: 'sse-event',
              data: JSON.stringify({
                type: 'response.output_item.done',
                item: {
                  id: 'rs_live',
                  type: 'reasoning',
                  encrypted_content: 'gAAAAAB' + 'a'.repeat(80),
                },
              }),
            },
            {
              seq: 1,
              kind: 'sse-event',
              data: JSON.stringify({
                type: 'response.output_item.done',
                item: { id: 'fc_live', type: 'function_call', call_id: 'call_live' },
              }),
            },
          ],
        },
      ],
    });
    const data = result.envelope.turns[0]!.frames[0];
    expect(data.kind === 'sse-event' && data.data).toContain('rs_<1>');
    expect(data.kind === 'sse-event' && data.data).toContain('[REDACTED]');
    expect(result.report.placeholders).toMatchObject({ rs_live: 'rs_<1>', fc_live: 'fc_<2>' });
    expect(scanFixtureSecrets(result.envelope).safe).toBe(true);
  });
});
