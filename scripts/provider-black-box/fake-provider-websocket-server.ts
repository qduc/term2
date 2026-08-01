import { WebSocketServer, WebSocket } from 'ws';
import type { FixtureEnvelopeV1, WsMessageFrame } from './fixture-envelope.js';
import { canonicalizeFixtureValue } from './fixture-comparator.js';

export type WebSocketReplaySession = { sent: unknown[]; received: unknown[]; failures: string[] };
export interface FakeProviderWebSocketServer {
  readonly url: string;
  readonly sessions: WebSocketReplaySession[];
  close(): Promise<void>;
  assertValid(): void;
}

export async function startFakeProviderWebSocketServer(options: {
  fixture: FixtureEnvelopeV1;
  port?: number;
}): Promise<FakeProviderWebSocketServer> {
  const sessions: WebSocketReplaySession[] = [];
  const wsServer = new WebSocketServer({ port: options.port ?? 0, host: '127.0.0.1' });
  await new Promise<void>((resolve, reject) => {
    wsServer.once('listening', resolve);
    wsServer.once('error', reject);
  });
  wsServer.on('connection', (socket) => {
    const session: WebSocketReplaySession = { sent: [], received: [], failures: [] };
    sessions.push(session);
    const turn = options.fixture.turns[sessions.length - 1];
    const frames = turn?.frames.filter((frame): frame is WsMessageFrame => frame.kind === 'ws-message') ?? [];
    let cursor = 0;
    const replayReceives = () => {
      while (cursor < frames.length && frames[cursor]?.direction === 'receive') {
        const frame = frames[cursor++]!;
        session.received.push(frame.data);
        socket.send(JSON.stringify(frame.data) ?? 'null');
      }
    };
    if (!turn) session.failures.push(`Unexpected websocket session #${sessions.length}`);
    replayReceives();
    socket.on('message', (raw) => {
      let actual: unknown = raw.toString();
      try {
        actual = JSON.parse(String(actual));
      } catch {
        /* preserve text */
      }
      session.sent.push(actual);
      const expected = frames[cursor];
      if (!expected || expected.direction !== 'send') {
        session.failures.push(`Unexpected websocket send at frame ${cursor}: ${JSON.stringify(actual)}`);
        socket.close(1008, 'unexpected message');
        return;
      }
      const expectedValue = canonicalizeFixtureValue(expected.data, options.fixture.placeholders);
      const actualValue = canonicalizeFixtureValue(actual, options.fixture.placeholders);
      if (JSON.stringify(expectedValue) !== JSON.stringify(actualValue)) {
        session.failures.push(
          `Websocket message ${cursor} differs\nexpected: ${JSON.stringify(expectedValue)}\nactual: ${JSON.stringify(
            actualValue,
          )}`,
        );
        socket.close(1008, 'message mismatch');
        return;
      }
      cursor++;
      replayReceives();
      if (cursor === frames.length) socket.close(1000, 'replay complete');
    });
    socket.on('close', () => {
      if (cursor < frames.length) session.failures.push(`Websocket closed before frame ${cursor} of ${frames.length}`);
    });
  });
  const address = wsServer.address();
  if (!address || typeof address === 'string') throw new Error('Fake websocket server did not bind');
  return {
    url: `ws://127.0.0.1:${address.port}`,
    sessions,
    close: () => new Promise((resolve, reject) => wsServer.close((error) => (error ? reject(error) : resolve()))),
    assertValid: () => {
      const failures = sessions.flatMap((session) => session.failures);
      if (failures.length) throw new Error(failures.join('\n'));
    },
  };
}
