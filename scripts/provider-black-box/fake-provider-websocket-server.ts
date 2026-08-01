import { WebSocketServer, WebSocket } from 'ws';
import type { FixtureEnvelopeV1, WsMessageFrame } from './fixture-envelope.js';
import { canonicalizeFixtureValue } from './fixture-comparator.js';

export type FakeProviderWebSocketScenario = 'success' | 'native-error' | 'incomplete' | 'abnormal-close';

export type WebSocketReplaySession = {
  sent: unknown[];
  received: unknown[];
  failures: string[];
  replayCursor: number;
  replayComplete: boolean;
};

export interface FakeProviderWebSocketServer {
  readonly url: string;
  readonly sessions: WebSocketReplaySession[];
  close(): Promise<void>;
  assertValid(): void;
}

export interface FakeProviderWebSocketServerOptions {
  /** Replay an existing bidirectional fixture exactly. */
  fixture?: FixtureEnvelopeV1;
  /** Build one deterministic Responses-style scenario when no fixture exists. */
  scenario?: FakeProviderWebSocketScenario;
  /** Exact client messages expected by a generated scenario. */
  expectedOutbound?: readonly unknown[];
  /** Select the generated fixture family for OpenAI Responses or Codex. */
  wireFamily?: 'openai-responses' | 'codex-responses';
  /** Compatibility alias for callers that name the transport protocol. */
  protocol?: 'responses' | 'codex-responses' | 'codex';
  provider?: string;
  model?: string;
  port?: number;
}

type ReplayTurn = {
  frames: WsMessageFrame[];
  intentionalClose: boolean;
  abnormalClose: boolean;
};

export async function startFakeProviderWebSocketServer(
  options: FakeProviderWebSocketServerOptions,
): Promise<FakeProviderWebSocketServer> {
  if (options.fixture && options.scenario)
    throw new Error('Fake WebSocket server accepts a fixture or scenario, not both.');
  if (!options.fixture && !options.scenario) throw new Error('Fake WebSocket server needs a fixture or scenario.');

  const generated = options.fixture
    ? undefined
    : createScenarioFixture(
        options.scenario!,
        options.expectedOutbound ?? [{ type: 'response.create', model: options.model ?? 'fixture' }],
        options,
      );
  const fixture = options.fixture ?? generated!.fixture;
  if (fixture.transport !== 'websocket')
    throw new Error(`Fake WebSocket server requires fixture transport 'websocket', got '${fixture.transport}'.`);
  const turns = fixture.turns.map((turn, index) => {
    if (turn.frames.some((frame) => frame.kind !== 'ws-message'))
      throw new Error(`WebSocket replay turn ${index} contains non-WebSocket frames.`);
    const frames = turn.frames.filter((frame): frame is WsMessageFrame => frame.kind === 'ws-message');
    if (!frames.some((frame) => frame.direction === 'send') || !frames.some((frame) => frame.direction === 'receive'))
      throw new Error(`WebSocket replay turn ${index} must contain a meaningful websocket exchange.`);
    return {
      frames,
      intentionalClose: Boolean(generated?.intentionalClose) || Boolean(options.fixture),
      abnormalClose: Boolean(generated?.abnormalClose),
    };
  });
  const sessions: WebSocketReplaySession[] = [];
  const clients = new Set<WebSocket>();
  let closing = false;
  let closePromise: Promise<void> | undefined;
  const wsServer = new WebSocketServer({ port: options.port ?? 0, host: '127.0.0.1' });

  try {
    await new Promise<void>((resolve, reject) => {
      wsServer.once('listening', resolve);
      wsServer.once('error', reject);
    });
  } catch (error) {
    await closeWebSocketServer(wsServer, clients).catch(() => undefined);
    throw error;
  }

  wsServer.on('connection', (socket) => {
    clients.add(socket);
    const session: WebSocketReplaySession = {
      sent: [],
      received: [],
      failures: [],
      replayCursor: 0,
      replayComplete: false,
    };
    sessions.push(session);
    const turn = turns[sessions.length - 1];
    const frames = turn?.frames ?? [];
    let cursor = 0;
    let closeScheduled = false;
    let replayFailed = false;
    let replayPromise = Promise.resolve();

    if (!turn) {
      session.failures.push(`Unexpected websocket session #${sessions.length}`);
      socket.close(1008, 'unexpected session');
      return;
    }

    const replayReceives = () => {
      replayPromise = replayPromise
        .then(async () => {
          while (!replayFailed && cursor < frames.length && frames[cursor]?.direction === 'receive') {
            const frame = frames[cursor]!;
            await sendWebSocketFrame(socket, frame.data);
            cursor += 1;
            session.replayCursor = cursor;
            session.received.push(frame.data);
          }
          if (!replayFailed && cursor === frames.length && !closeScheduled && turn) {
            closeScheduled = true;
            session.replayComplete = true;
            if (turn.abnormalClose) queueMicrotask(() => socket.terminate());
            else if (turn.intentionalClose) queueMicrotask(() => socket.close(1000, 'replay complete'));
          }
        })
        .catch((error: unknown) => {
          replayFailed = true;
          session.failures.push(
            `Failed to replay websocket frame ${cursor}: ${error instanceof Error ? error.message : String(error)}`,
          );
          try {
            socket.close(1011, 'replay failed');
          } catch {
            /* best effort */
          }
        });
    };

    replayReceives();
    socket.on('message', (raw) => {
      if (replayFailed) return;
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
      const expectedValue = canonicalizeFixtureValue(expected.data, fixture.placeholders);
      const actualValue = canonicalizeFixtureValue(actual, fixture.placeholders);
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
      session.replayCursor = cursor;
      replayReceives();
    });
    socket.on('error', (error) => {
      if (!closing && !turn?.abnormalClose) session.failures.push(`Websocket error: ${error.message}`);
    });
    socket.on('close', () => {
      clients.delete(socket);
      if (turn && (!session.replayComplete || cursor < frames.length) && !turn.abnormalClose) {
        session.failures.push(`Websocket closed before frame ${cursor} of ${frames.length}`);
      }
    });
  });

  const address = wsServer.address();
  if (!address || typeof address === 'string') {
    await closeWebSocketServer(wsServer, clients).catch(() => undefined);
    throw new Error('Fake websocket server did not bind');
  }

  const close = async (): Promise<void> => {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      closing = true;
      await closeWebSocketServer(wsServer, clients);
    })();
    return closePromise;
  };

  return {
    url: `ws://127.0.0.1:${address.port}`,
    sessions,
    close,
    assertValid: () => {
      // A missing connection or a client that never sends its request must
      // fail loudly; otherwise a silent WS->HTTP fallback can pass vacuously.
      if (sessions.length !== fixture.turns.length)
        throw new Error(`WebSocket replay expected ${fixture.turns.length} session(s), got ${sessions.length}`);
      const failures = sessions.flatMap((session, index) => {
        const turn = turns[index];
        const expectedSends = turn?.frames.filter((frame) => frame.direction === 'send').length ?? 0;
        const expectedReceives = turn?.frames.filter((frame) => frame.direction === 'receive').length ?? 0;
        const sessionFailures = [...session.failures];
        if (session.sent.length !== expectedSends) {
          sessionFailures.push(
            `Websocket session #${index + 1} expected ${expectedSends} outbound message(s), got ${session.sent.length}`,
          );
        }
        if (session.received.length !== expectedReceives) {
          sessionFailures.push(
            `Websocket session #${index + 1} expected ${expectedReceives} replayed message(s), got ${
              session.received.length
            }`,
          );
        }
        if (!session.replayComplete || session.replayCursor !== (turn?.frames.length ?? 0)) {
          sessionFailures.push(
            `Websocket session #${index + 1} replay cursor incomplete: ${session.replayCursor}/${
              turn?.frames.length ?? 0
            }`,
          );
        }
        return sessionFailures.map((failure) => `session #${index + 1}: ${failure}`);
      });
      if (failures.length) throw new Error(failures.join('\n'));
    },
  };
}

function sendWebSocketFrame(socket: WebSocket, data: unknown): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (socket.readyState !== WebSocket.OPEN) {
      reject(new Error(`socket is not open (readyState ${socket.readyState})`));
      return;
    }
    try {
      socket.send(JSON.stringify(data), (error?: Error) => {
        if (error) reject(error);
        else resolve();
      });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function createScenarioFixture(
  scenario: FakeProviderWebSocketScenario,
  expectedOutbound: readonly unknown[],
  options: Pick<FakeProviderWebSocketServerOptions, 'wireFamily' | 'protocol' | 'provider' | 'model'>,
): { fixture: FixtureEnvelopeV1; intentionalClose: boolean; abnormalClose: boolean } {
  const outboundFrames: WsMessageFrame[] = expectedOutbound.map((data, index) => ({
    seq: index,
    kind: 'ws-message',
    direction: 'send',
    data,
  }));
  const responseId = `resp_ws_${scenario}`;
  const receives: unknown[] =
    scenario === 'native-error'
      ? [
          { type: 'response.created', response: { id: responseId, status: 'in_progress' } },
          {
            type: 'response.failed',
            response: {
              id: responseId,
              status: 'failed',
              error: { code: 'fixture_error', message: 'Injected native provider failure' },
            },
          },
        ]
      : [
          { type: 'response.created', response: { id: responseId, status: 'in_progress' } },
          { type: 'response.output_text.delta', delta: 'hello' },
          ...(scenario === 'success'
            ? [
                {
                  type: 'response.completed',
                  response: {
                    id: responseId,
                    status: 'completed',
                    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hello' }] }],
                  },
                },
              ]
            : []),
        ];
  const receiveFrames: WsMessageFrame[] = receives.map((data, index) => ({
    seq: outboundFrames.length + index,
    kind: 'ws-message',
    direction: 'receive',
    data,
  }));
  return {
    fixture: {
      schemaVersion: 1,
      kind: 'real-traffic-recording',
      provider: options.provider ?? 'fixture',
      wireFamily:
        options.wireFamily ??
        (options.protocol === 'codex' || options.protocol === 'codex-responses'
          ? 'codex-responses'
          : 'openai-responses'),
      transport: 'websocket',
      capture: {
        sdkPackage: 'fixture',
        apiSdkVersion: '1.0.0',
        model: options.model ?? 'fixture',
        modelFamily: 'fixture',
        capturedAt: '2026-01-01T00:00:00.000Z',
        recorderVersion: '1',
        probeScenario: `ws:${scenario}`,
      },
      placeholders: {},
      turns: [{ frames: [...outboundFrames, ...receiveFrames] }],
    },
    intentionalClose: true,
    abnormalClose: scenario === 'abnormal-close',
  };
}

async function closeWebSocketServer(wsServer: WebSocketServer, clients: Set<WebSocket>): Promise<void> {
  for (const client of clients) {
    try {
      client.close(1001, 'server shutdown');
    } catch {
      /* best effort */
    }
    if (client.readyState !== WebSocket.CLOSED) client.terminate();
  }
  await new Promise<void>((resolve, reject) => {
    wsServer.close((error) => {
      if (!error || (error as NodeJS.ErrnoException).code === 'ERR_SERVER_NOT_RUNNING') resolve();
      else reject(error);
    });
  });
}
