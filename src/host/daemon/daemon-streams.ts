/**
 * Long-lived stream subscriptions and cursor-replay pumping for the Client API v1.0:
 * `session.list.subscribe`, `session.attach` (snapshot & replay), and `settings.subscribe`.
 */
import type { WireSnapshot } from '../../protocol/wire.js';
import { DirectProtocolError } from '../../protocol/errors.js';
import { CLIENT_API_SCHEMAS } from '../../protocol/client-api/client-api-schema.js';
import { isClientApiVersionAtLeast } from '../../protocol/client-api/version-negotiation.js';
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
  readonly readTuiSettings?: (principal: Principal, sessionId?: string) => Promise<Record<string, unknown>>;
  readonly serializeSession: <T>(sessionId: string, operation: () => Promise<T>) => Promise<T>;
  readonly shutdownReason: () => 'closed' | 'daemon_shutdown';
  /**
   * Opens the connection behind a `session.attach`, given the Unix connection that asked, so the
   * daemon can hold it to what that connection launched. Without it, a plain `host.connect`.
   */
  readonly attachSession?: (
    principal: Principal,
    sessionId: string,
    fromSeq: number | undefined,
    connectionId: string | undefined,
  ) => Promise<DirectConnection | DirectReplayConnection>;
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
          if (batch.kind === 'accepted') {
            if (batch.seq === null || batch.occurredAt === null) throw new Error('Invalid accepted batch.');
            emit({
              event: 'session.accepted',
              payload: {
                sessionId,
                seq: batch.seq,
                occurredAt: batch.occurredAt,
                events: batch.events as unknown as Record<string, unknown>[],
              },
            });
          } else if (batch.events.length > 0) {
            emit({
              event: 'session.live',
              // Preserve authoritative state synchronization when shedding transient updates.
              transient: batch.kind === 'live',
              payload: {
                sessionId,
                events: batch.events as unknown as Record<string, unknown>[],
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
  connectionId: string | undefined,
): Promise<StreamRegistration> {
  const expectedEpoch = params.sessionId;
  const attach = deps.attachSession;
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
      replayConn = attach
        ? ((await attach(principal, params.sessionId, params.fromSeq, connectionId)) as DirectReplayConnection)
        : await deps.host.connect(principal, params.sessionId, params.fromSeq);
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

  const connection = attach
    ? ((await attach(principal, params.sessionId, undefined, connectionId)) as DirectConnection)
    : await deps.host.connect(principal, params.sessionId);
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
  protocolVersion?: string,
  connectionId?: string,
): Promise<StreamRegistration> {
  const params = rawParams === undefined ? {} : asRecord(rawParams, method);
  const allowV11 = isClientApiVersionAtLeast(protocolVersion ?? '1.0', '1.1');
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
    if (!allowV11) {
      const keys = Object.keys(params);
      if (keys.length > 0) {
        throw new ClientApiRpcError('invalid_request', `Unrecognized key "${keys[0]}" in settings.subscribe.`);
      }
    }
    const parsed = allowV11
      ? parseStrict(CLIENT_API_SCHEMAS.settingsSubscribeParamsV11, params, 'settings.subscribe')
      : {};
    const tuiMode = parsed.view === 'tui' || parsed.sessionId !== undefined;
    if (tuiMode && !deps.readTuiSettings) {
      throw new ClientApiRpcError('unavailable', 'Scoped TUI settings stream unavailable.', { retryable: true });
    }
    const read = deps.configuration?.read;
    if (!tuiMode && !read) {
      throw new ClientApiRpcError('unavailable', 'Settings configuration unavailable.', { retryable: true });
    }
    const buffered: StreamEventFrame[] = [];
    let capturedEmit: ((frame: StreamEventFrame) => void) | null = null;
    let streamClosed = false;
    let pendingTuiRead: Promise<void> = Promise.resolve();
    const { initial, unsubscribe } = await deps.mutations.runSettings(async () => {
      const snap = tuiMode
        ? await deps.readTuiSettings!(principal, parsed.sessionId)
        : (() => read!.call(deps.configuration))();
      const resolvedSnap = await snap;
      const unsub = deps.mutations.subscribeSettings((update) => {
        if (streamClosed) return;
        if (tuiMode) {
          pendingTuiRead = pendingTuiRead.then(async () => {
            if (streamClosed) return;
            try {
              const next = await deps.readTuiSettings!(principal, parsed.sessionId);
              if (streamClosed) return;
              const frame: StreamEventFrame = {
                event: 'settings.changed',
                payload: { revision: next['revision'], settings: next['settings'] },
              };
              if (capturedEmit) capturedEmit(frame);
              else buffered.push(frame);
            } catch {
              // Session closed or settings temporarily unavailable; keep stream alive without resurrecting.
            }
          });
          return;
        }
        const frame: StreamEventFrame = {
          event: 'settings.changed',
          payload: { revision: update.revision, settings: update.settings },
        };
        if (capturedEmit) capturedEmit(frame);
        else buffered.push(frame);
      });
      return {
        initial: tuiMode
          ? { revision: resolvedSnap['revision'], settings: resolvedSnap['settings'] }
          : { revision: (resolvedSnap as { revision: string }).revision, settings: { ...resolvedSnap } },
        unsubscribe: unsub,
      };
    });
    const initialEvent: StreamEventFrame = {
      event: 'settings.snapshot',
      payload: initial as Record<string, unknown>,
    };
    return {
      result: {},
      initialEvent,
      start(emit) {
        capturedEmit = emit;
        for (const frame of buffered.splice(0)) emit(frame);
        return () => {
          streamClosed = true;
          unsubscribe();
        };
      },
    };
  }

  if (method === 'session.attach') {
    const parsed = parseStrict(CLIENT_API_SCHEMAS.sessionAttachParams, params, 'session.attach');
    return await deps.serializeSession(parsed.sessionId, () =>
      attachSessionStream(deps, principal, parsed, connectionId),
    );
  }

  throw new ClientApiRpcError('invalid_request', `Unknown stream method "${method}".`);
}

export function createDaemonConnectionContext(
  connectionId: string,
  cleanups: Set<() => void | Promise<void>>,
  emit: (event: string, payload: Record<string, unknown>) => void,
  isClosed: () => boolean,
): {
  readonly connectionId: string;
  emitEvent(event: string, payload: Record<string, unknown>): void;
  onDisconnect(cleanup: () => void | Promise<void>): () => void;
} {
  return {
    connectionId,
    emitEvent: emit,
    onDisconnect(cleanup) {
      if (isClosed()) {
        void Promise.resolve(cleanup()).catch(() => undefined);
        return () => undefined;
      }
      cleanups.add(cleanup);
      return () => {
        cleanups.delete(cleanup);
      };
    },
  };
}

export const STREAM_OPEN_METHODS = new Set(['session.list.subscribe', 'session.attach', 'settings.subscribe']);
export const STREAM_CLOSE_OPEN_MAP = new Map<string, string>([
  ['session.list.unsubscribe', 'session.list.subscribe'],
  ['session.detach', 'session.attach'],
  ['settings.unsubscribe', 'settings.subscribe'],
]);

export function enqueueStreamFrame(
  queue: StreamEventFrame[],
  maxQueue: number,
  method: string,
  sessionId: string | undefined,
  frame: StreamEventFrame,
): StreamEventFrame | null {
  if (queue.length < maxQueue) {
    queue.push(frame);
    return null;
  }
  if (frame.transient) return null;
  const transientIdx = queue.findIndex((queued) => queued.transient === true);
  if (transientIdx !== -1) {
    queue.splice(transientIdx, 1);
    queue.push(frame);
    return null;
  }
  queue.length = 0;
  return buildSlowConsumerFrame(method, sessionId);
}

function buildSlowConsumerFrame(method: string, sessionId?: string): StreamEventFrame {
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
