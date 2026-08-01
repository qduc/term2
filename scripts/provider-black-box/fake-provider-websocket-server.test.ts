import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { startFakeProviderWebSocketServer } from './fake-provider-websocket-server.js';
import type { FixtureEnvelopeV1 } from './fixture-envelope.js';

const fixture: FixtureEnvelopeV1 = {
  schemaVersion: 1,
  kind: 'real-traffic-recording',
  provider: 'fixture',
  wireFamily: 'openai-responses',
  transport: 'websocket',
  capture: {
    sdkPackage: 'fixture',
    apiSdkVersion: '1.0.0',
    model: 'fixture',
    modelFamily: 'fixture',
    capturedAt: '2026-01-01T00:00:00.000Z',
    recorderVersion: '1',
    probeScenario: 'ws',
  },
  placeholders: {},
  turns: [
    {
      frames: [
        { seq: 0, kind: 'ws-message', direction: 'send', data: { type: 'response.create', model: 'fixture' } },
        {
          seq: 1,
          kind: 'ws-message',
          direction: 'receive',
          data: { type: 'response.created', response: { id: 'resp_fixture' } },
        },
        { seq: 2, kind: 'ws-message', direction: 'send', data: { type: 'response.cancel' } },
        { seq: 3, kind: 'ws-message', direction: 'receive', data: { type: 'response.done' } },
      ],
    },
  ],
};
let server: Awaited<ReturnType<typeof startFakeProviderWebSocketServer>> | undefined;
afterEach(async () => {
  const current = server;
  try {
    await current?.close();
  } finally {
    // Keep the reference reset even if a close assertion fails.
    server = undefined;
  }
});

describe('fixture WebSocket replay', () => {
  it('validates ordered sends and replays receives', async () => {
    server = await startFakeProviderWebSocketServer({ fixture });
    const socket = new WebSocket(server.url);
    const received: unknown[] = [];
    await new Promise<void>((resolve, reject) => {
      socket.on('open', () => socket.send(JSON.stringify({ type: 'response.create', model: 'fixture' })));
      socket.on('message', (data) => {
        received.push(JSON.parse(data.toString()));
        if (received.length === 1) socket.send(JSON.stringify({ type: 'response.cancel' }));
      });
      socket.on('close', () => resolve());
      socket.on('error', reject);
    });
    expect(received).toEqual([
      { type: 'response.created', response: { id: 'resp_fixture' } },
      { type: 'response.done' },
    ]);
    expect(server.sessions[0]!.failures).toEqual([]);
    server.assertValid();
  });
  it('rejects a reordered send', async () => {
    server = await startFakeProviderWebSocketServer({ fixture });
    const socket = new WebSocket(server.url);
    await new Promise<void>((resolve) => {
      socket.on('open', () => socket.send(JSON.stringify({ type: 'wrong' })));
      socket.on('close', () => resolve());
    });
    expect(() => server!.assertValid()).toThrow(/differs|unexpected/i);
  });
  it('does not pass vacuously when no session ever connects', async () => {
    server = await startFakeProviderWebSocketServer({ fixture });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(() => server!.assertValid()).toThrow(/session/i);
  });

  it('rejects a non-WebSocket fixture before starting a vacuous replay server', async () => {
    const nonWebSocketFixture: FixtureEnvelopeV1 = { ...fixture, transport: 'http-sse' };
    await expect(startFakeProviderWebSocketServer({ fixture: nonWebSocketFixture })).rejects.toThrow(
      /transport.*websocket/i,
    );
  });

  it.each([
    ['empty turn', []],
    ['receive-only turn', [{ seq: 0, kind: 'ws-message', direction: 'receive', data: { type: 'response.created' } }]],
    ['send-only turn', [{ seq: 0, kind: 'ws-message', direction: 'send', data: { type: 'response.create' } }]],
  ] as const)('rejects a %s without a meaningful exchange', async (_label, frames) => {
    const invalidFixture: FixtureEnvelopeV1 = { ...fixture, turns: [{ frames: [...frames] }] };
    await expect(startFakeProviderWebSocketServer({ fixture: invalidFixture })).rejects.toThrow(
      /meaningful websocket exchange/i,
    );
  });

  it('rejects a turn containing non-WebSocket frames instead of filtering them', async () => {
    const invalidFixture: FixtureEnvelopeV1 = {
      ...fixture,
      turns: [
        {
          frames: [
            { seq: 0, kind: 'http-request', method: 'POST', urlPath: '/v1/responses', headers: {}, body: {} },
            { seq: 1, kind: 'ws-message', direction: 'send', data: { type: 'response.create' } },
            { seq: 2, kind: 'ws-message', direction: 'receive', data: { type: 'response.created' } },
          ],
        },
      ],
    };
    await expect(startFakeProviderWebSocketServer({ fixture: invalidFixture })).rejects.toThrow(
      /non-WebSocket frames/i,
    );
  });

  it('fails validation when a client closes before the replay cursor completes', async () => {
    server = await startFakeProviderWebSocketServer({ fixture });
    const socket = new WebSocket(server.url);
    await new Promise<void>((resolve) => {
      socket.on('open', () => socket.send(JSON.stringify({ type: 'response.create', model: 'fixture' })));
      socket.on('message', () => {
        socket.close();
        resolve();
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(() => server!.assertValid()).toThrow(/replay cursor|before frame|outbound message/i);
  });

  it.each([
    ['success', ['response.created', 'response.output_text.delta', 'response.completed']],
    ['native-error', ['response.created', 'response.failed']],
    ['incomplete', ['response.created', 'response.output_text.delta']],
    ['abnormal-close', ['response.created', 'response.output_text.delta']],
  ] as const)(
    'drives the deterministic %s scenario with ordered, non-empty frames',
    async (scenario, expectedTypes) => {
      server = await startFakeProviderWebSocketServer({
        scenario,
        expectedOutbound: [{ type: 'response.create', model: 'fixture' }],
      });
      const socket = new WebSocket(server.url);
      const received: unknown[] = [];
      await new Promise<void>((resolve, reject) => {
        socket.on('open', () => socket.send(JSON.stringify({ type: 'response.create', model: 'fixture' })));
        socket.on('message', (data) => received.push(JSON.parse(data.toString())));
        socket.on('close', () => resolve());
        socket.on('error', reject);
      });

      expect(received).not.toHaveLength(0);
      expect(received.map((message: any) => message.type)).toEqual(expectedTypes);
      if (scenario === 'success') expect(received.at(-1)).toMatchObject({ type: 'response.completed' });
      else expect(received.some((message: any) => message.type === 'response.completed')).toBe(false);
      expect(server.sessions[0]?.sent).toEqual([{ type: 'response.create', model: 'fixture' }]);
      server.assertValid();
    },
  );

  it('rejects an outbound ordering mismatch in a generated scenario', async () => {
    server = await startFakeProviderWebSocketServer({
      scenario: 'success',
      expectedOutbound: [{ type: 'response.create', model: 'fixture' }, { type: 'response.cancel' }],
    });
    const socket = new WebSocket(server.url);
    await new Promise<void>((resolve) => {
      socket.on('open', () => socket.send(JSON.stringify({ type: 'response.cancel' })));
      socket.on('close', () => resolve());
    });
    expect(() => server!.assertValid()).toThrow(/differs|unexpected/i);
  });
});
