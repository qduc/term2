/**
 * Long-lived stream subscriptions and cursor-replay pumping for the Client API v1.0:
 * `session.list.subscribe`, `session.attach` (snapshot & replay), and `settings.subscribe`.
 */
import type { WireEvent, WireSnapshot } from '../../protocol/wire.js';
import { DirectProtocolError } from '../../protocol/errors.js';
import { CLIENT_API_SCHEMAS } from '../../protocol/client-api/client-api-schema.js';
import type { DirectConnection, DirectHost, DirectReplayConnection, Principal } from '../in-process-direct-types.js';
import type { ServerConfiguration } from '../server-contracts.js';
import type { GlobalMutationCoordinator } from './global-mutations.js';
import type { SessionIndex, SessionListStreamEvent } from './session-index.js';
import { asRecord, ClientApiRpcError, parseStrict } from './daemon-errors.js';

export type StreamEventFrame = {
  readonly event: string;
  readonly payload: Record<string, unknown>;
  readonly transient?: boolean;
  readonly terminal?: boolean;
};

export type StreamRegistration = {
  readonly result: Record<string, unknown>;
  readonly initialEvent?: StreamEventFrame;
  start(emit: (frame: StreamEventFrame) => void): () => void;
};

export type DaemonStreamDeps = {
  readonly host: DirectHost;
  readonly sessionIndex: SessionIndex;
  readonly mutations: GlobalMutationCoordinator;
  readonly configuration?: ServerConfiguration;
  readonly serializeSession: <T>(sessionId: string, operation: () => Promise<T>) => Promise<T>;
  readonly shutdownReason: () => 'closed' | 'daemon_shutdown';
};

function earliestReplayableOf(snapshot: WireSnapshot | null): number {
  const raw = (snapshot as { earliestReplayableSequence?: unknown } | null)?.earliestReplayableSequence;
  return typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 1 ? raw : 1;
}

function pumpSessionConnection(
  sessionId: string,
  connection: DirectConnection | DirectReplayConnection,
  emit: (frame: StreamEventFrame) => void,
  shutdownReason: () => 'closed' | 'daemon_shutdown',
  dropThroughOrdinal = -1,
): () => void {
  let closed = false;
  const pump = async () => {
    try {
      if (connection.batches) {
        for await (const batch of connection.batches()) {
          if (closed) break;
          if (batch.ordinal <= dropThroughOrdinal) continue;
          if (batch.events.length === 0) continue;
          const acceptedEvents: WireEvent[] = [];
          const liveEvents: WireEvent[] = [];
          for (const event of batch.events) {
            if (event.seq !== null) acceptedEvents.push(event);
            else liveEvents.push(event);
          }
          if (acceptedEvents.length > 0) {
            const last = acceptedEvents[acceptedEvents.length - 1]!;
            emit({
              event: 'session.accepted',
              payload: {
                sessionId,
                seq: last.seq!,
                occurredAt: last.occurredAt,
                events: acceptedEvents as unknown as Record<string, unknown>[],
              },
            });
          }
          if (liveEvents.length > 0) {
            emit({
              event: 'session.live',
              transient: true,
              payload: {
                sessionId,
                events: liveEvents as unknown as Record<string, unknown>[],
              },
            });
          }
        }
      } else {
        for await (const event of connection.events) {
          if (closed) break;
          if (event.seq !== null) {
            emit({
              event: 'session.accepted',
              payload: {
                sessionId,
                seq: event.seq,
                occurredAt: event.occurredAt,
                events: [event as unknown as Record<string, unknown>],
              },
            });
          } else {
            emit({
              event: 'session.live',
              transient: true,
              payload: { sessionId, events: [event as unknown as Record<string, unknown>] },
            });
          }
        }
      }
      if (!closed) {
        emit({ event: 'session.closed', terminal: true, payload: { sessionId, reason: shutdownReason() } });
      }
    } catch {
      if (!closed) {
        emit({ event: 'session.closed', terminal: true, payload: { sessionId, reason: shutdownReason() } });
      }
    }
  };
  void pump();
  return () => {
    if (closed) return;
    closed = true;
    connection.close();
  };
}

async function attachSessionStream(
  deps: DaemonStreamDeps,
  principal: Principal,
  params: { readonly sessionId: string; readonly fromSeq?: number; readonly sessionEpoch?: string },
): Promise<StreamRegistration> {
  const expectedEpoch = params.sessionId;
  if (params.fromSeq !== undefined && params.sessionEpoch !== undefined && params.sessionEpoch !== expectedEpoch) {
    const indexed = await deps.sessionIndex.get(principal, params.sessionId);
    throw new ClientApiRpcError('cursor_out_of_range', 'Session epoch mismatch; re-attach with a fresh snapshot.', {
      details: {
        earliestReplayableSequence: 1,
        latestSequence: indexed?.latestSequence ?? 0,
        sessionEpoch: expectedEpoch,
      },
    });
  }

  if (params.fromSeq !== undefined) {
    let replayConn: DirectReplayConnection;
    try {
      replayConn = await deps.host.connect(principal, params.sessionId, params.fromSeq);
    } catch (error) {
      if (error instanceof DirectProtocolError && error.code === 'replay_unavailable') {
        const indexed = await deps.sessionIndex.get(principal, params.sessionId);
        throw new ClientApiRpcError('cursor_out_of_range', error.message, {
          details: {
            earliestReplayableSequence: 1,
            latestSequence: indexed?.latestSequence ?? 0,
            sessionEpoch: expectedEpoch,
          },
        });
      }
      throw error;
    }
    return {
      result: { mode: 'replay', sessionEpoch: expectedEpoch, earliestReplayableSequence: 1 },
      start: (emit) => pumpSessionConnection(params.sessionId, replayConn, emit, deps.shutdownReason),
    };
  }

  const connection = await deps.host.connect(principal, params.sessionId);
  const cut = connection.cut?.();
  const snapshot = cut?.snapshot ?? connection.snapshot;
  const cutOrdinal = cut?.ordinal ?? -1;
  const earliestReplayableSequence = earliestReplayableOf(snapshot);
  const initialEvent: StreamEventFrame = {
    event: 'session.snapshot',
    payload: {
      sessionId: params.sessionId,
      seq: snapshot.seq,
      earliestReplayableSequence,
      sessionEpoch: expectedEpoch,
      snapshot: snapshot as unknown as Record<string, unknown>,
    },
  };
  return {
    result: { mode: 'snapshot', sessionEpoch: expectedEpoch, earliestReplayableSequence },
    initialEvent,
    start: (emit) => pumpSessionConnection(params.sessionId, connection, emit, deps.shutdownReason, cutOrdinal),
  };
}

export async function openDaemonStream(
  deps: DaemonStreamDeps,
  principal: Principal,
  method: string,
  rawParams: unknown,
): Promise<StreamRegistration> {
  const params = rawParams === undefined ? {} : asRecord(rawParams, method);
  if (method === 'session.list.subscribe') {
    const parsed = parseStrict(CLIENT_API_SCHEMAS.sessionListSubscribeParams, params, 'session.list.subscribe');
    let capturedEmit: ((frame: StreamEventFrame) => void) | null = null;
    const buffered: StreamEventFrame[] = [];
    let initialEvent: StreamEventFrame | undefined;
    const handle = await deps.sessionIndex.subscribe(principal, parsed, (event: SessionListStreamEvent) => {
      const { event: eventName, ...payload } = event;
      const frame: StreamEventFrame = { event: eventName, payload: payload as Record<string, unknown> };
      if (eventName === 'session.list.snapshot' && !initialEvent) {
        initialEvent = frame;
        return;
      }
      if (capturedEmit) capturedEmit(frame);
      else buffered.push(frame);
    });
    return {
      result: {},
      ...(initialEvent ? { initialEvent } : {}),
      start(emit) {
        capturedEmit = emit;
        for (const frame of buffered.splice(0)) emit(frame);
        return () => handle.unsubscribe();
      },
    };
  }

  if (method === 'settings.subscribe') {
    const read = deps.configuration?.read;
    if (!read) throw new ClientApiRpcError('unavailable', 'Settings configuration unavailable.', { retryable: true });
    const buffered: StreamEventFrame[] = [];
    let capturedEmit: ((frame: StreamEventFrame) => void) | null = null;
    const { projection, unsubscribe } = await deps.mutations.runSettings(async () => {
      const current = await read.call(deps.configuration);
      const unsub = deps.mutations.subscribeSettings((update) => {
        const frame: StreamEventFrame = {
          event: 'settings.changed',
          payload: { revision: update.revision, settings: update.settings },
        };
        if (capturedEmit) capturedEmit(frame);
        else buffered.push(frame);
      });
      return { projection: current, unsubscribe: unsub };
    });
    const initialEvent: StreamEventFrame = {
      event: 'settings.snapshot',
      payload: { revision: projection.revision, settings: { ...projection } },
    };
    return {
      result: {},
      initialEvent,
      start(emit) {
        capturedEmit = emit;
        for (const frame of buffered.splice(0)) emit(frame);
        return unsubscribe;
      },
    };
  }

  if (method === 'session.attach') {
    const parsed = parseStrict(CLIENT_API_SCHEMAS.sessionAttachParams, params, 'session.attach');
    return await deps.serializeSession(parsed.sessionId, () => attachSessionStream(deps, principal, parsed));
  }

  throw new ClientApiRpcError('invalid_request', `Unknown stream method "${method}".`);
}

export function buildSlowConsumerFrame(method: string, sessionId?: string): StreamEventFrame {
  if (method === 'session.attach') {
    return {
      event: 'session.resync_required',
      terminal: true,
      payload: {
        sessionId: sessionId ?? '',
        reason: 'slow_consumer',
        earliestReplayableSequence: 1,
        latestSequence: 0,
      },
    };
  }
  return { event: 'session.list.resync_required', terminal: true, payload: { reason: 'slow_consumer' } };
}
