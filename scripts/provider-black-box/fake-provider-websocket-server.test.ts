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
  await server?.close();
  server = undefined;
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
});
