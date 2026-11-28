import { CLIENT_API_SCHEMAS, type UnixEventFrame } from '../../protocol/client-api/client-api-schema.js';
import { DirectProtocolError } from '../../protocol/errors.js';
import { reduceWireEvent } from '../../protocol/reducer.js';
import type { WireCommand, WireEvent, WireSnapshot } from '../../protocol/wire.js';
import { DirectEventQueue, type WireEventBatch } from '../in-process-direct-queue.js';
import type { DirectConnection, DirectReplayConnection } from '../in-process-direct-types.js';
import type { UnixRpcClient, UnixStreamHandle } from './unix-rpc-client.js';

type SequencedSnapshot = WireSnapshot & { readonly seq: number };

function checkSnapshot(
  snapshot: WireSnapshot,
  sessionId: string,
  earliestSeq: number,
): asserts snapshot is SequencedSnapshot {
  if (
    snapshot?.sessionId !== sessionId ||
    snapshot.seq === null ||
    !Number.isSafeInteger(snapshot.seq) ||
    snapshot.seq < earliestSeq
  ) {
    throw new Error('Invalid session snapshot.');
  }
}

export async function attachRemoteDirectSession(
  rpc: UnixRpcClient,
  sessionId: string,
  fromSeq: number | undefined,
  snapshotTimeoutMs: number,
  send: DirectConnection['send'],
): Promise<DirectConnection | DirectReplayConnection> {
  let handle: UnixStreamHandle | null = null;
  let retired = false;
  let closeReason: 'closed' | 'daemon_shutdown' | 'workspace_revoked' | 'transport_lost' | null = null;
  let ordinal = 0;
  let current: WireSnapshot | undefined;
  let lastSeq = fromSeq;
  let resolveSnapshot: ((result: SequencedSnapshot | DirectProtocolError) => void) | undefined;
  const initialSnapshot =
    fromSeq === undefined
      ? new Promise<SequencedSnapshot | DirectProtocolError>((resolve) => {
          resolveSnapshot = resolve;
        })
      : undefined;
  const queue = new DirectEventQueue(detach);

  function detach() {
    if (!handle || retired) return;
    retired = true;
    handle.retireLocal();
    if (!rpc.closed) void rpc.request('session.detach', { streamId: handle.streamId }).catch(() => undefined);
  }

  function publish(batch: Omit<WireEventBatch, 'ordinal'>) {
    if (current) {
      current = batch.events.reduce(reduceWireEvent, current);
      // A durable fact can advance the sequence without projecting any events.
      if (batch.kind === 'accepted' && current.seq !== batch.seq) current = { ...current, seq: batch.seq };
    }
    queue.push({ ...batch, ordinal: ++ordinal });
  }

  function onEvent(frame: UnixEventFrame) {
    try {
      if (frame.event === 'session.snapshot') {
        const snapshot = frame.payload['snapshot'] as WireSnapshot;
        if (fromSeq !== undefined || current) throw new Error('Unexpected initial snapshot.');
        checkSnapshot(snapshot, sessionId, 0);
        current = snapshot;
        lastSeq = snapshot.seq;
        resolveSnapshot?.(snapshot);
      } else if (frame.event === 'session.accepted') {
        const batch = CLIENT_API_SCHEMAS.sessionAcceptedEvent.parse(frame.payload);
        if (batch.sessionId !== sessionId || lastSeq === undefined || batch.seq <= lastSeq) {
          throw new Error('Expected an accepted batch for this session after its previous sequence.');
        }
        publish({
          kind: 'accepted',
          seq: batch.seq,
          occurredAt: batch.occurredAt,
          events: batch.events as WireEvent[],
        });
        lastSeq = batch.seq;
      } else if (frame.event === 'session.live') {
        const live = CLIENT_API_SCHEMAS.sessionLiveEvent.parse(frame.payload);
        if (live.sessionId !== sessionId || lastSeq === undefined) throw new Error('Unexpected live batch.');
        const events = live.events as WireEvent[];
        const last = events.at(-1);
        if (last?.type === 'snapshot') {
          const { snapshot } = last.payload;
          checkSnapshot(snapshot, sessionId, lastSeq);
          publish({ kind: 'snapshot', seq: snapshot.seq, occurredAt: null, events });
          lastSeq = snapshot.seq;
        } else {
          publish({ kind: 'live', seq: null, occurredAt: null, events });
        }
      } else if (frame.event === 'session.resync_required') {
        retired = true;
        const error = new DirectProtocolError('replay_unavailable', 'Daemon stream requires resync.');
        resolveSnapshot?.(error);
        queue.fail(error);
      } else if (frame.event === 'session.closed') {
        retired = true;
        const closed = CLIENT_API_SCHEMAS.sessionClosedEvent.safeParse(frame.payload);
        const reason = closed.success ? closed.data.reason : 'closed';
        closeReason =
          reason === 'workspace_revoked'
            ? 'workspace_revoked'
            : reason === 'daemon_shutdown'
            ? 'daemon_shutdown'
            : 'closed';
        const error =
          reason === 'workspace_revoked'
            ? new DirectProtocolError('forbidden', 'Workspace access was revoked.')
            : new DirectProtocolError('closed', `Session ${sessionId} closed (${reason}).`);
        resolveSnapshot?.(error);
        if (reason === 'workspace_revoked') queue.fail(error);
        else queue.finish();
      }
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      const error = new DirectProtocolError('internal_error', `Invalid daemon session stream: ${detail}`);
      resolveSnapshot?.(error);
      queue.fail(error);
    }
  }

  handle = await rpc.subscribe('session.attach', fromSeq === undefined ? { sessionId } : { sessionId, fromSeq }, {
    onEvent,
    onClose(error) {
      retired = true;
      if (closeReason === null) closeReason = 'transport_lost';
      const dropped = new DirectProtocolError('unavailable', error?.message ?? 'Daemon connection closed.');
      resolveSnapshot?.(dropped);
      if (error) queue.fail(dropped);
      else queue.close();
    },
  });
  if (queue.closed) detach();

  const connection = {
    sessionId,
    events: queue,
    batches: () => queue.batches(),
    closeReason: () => closeReason,
    async send(command: WireCommand) {
      return queue.closed ? ({ ok: false, code: 'closed', message: 'Connection is closed.' } as const) : send(command);
    },
    close: () => queue.close(),
  };
  if (fromSeq !== undefined) {
    // Unix v1.0 has no replay-end marker or upper cursor in its reply.
    return { ...connection, snapshot: null, replay: { fromSeq, toSeq: null } };
  }

  const timer = setTimeout(() => {
    resolveSnapshot?.(new DirectProtocolError('unavailable', `Timed out waiting for a snapshot of ${sessionId}.`));
  }, snapshotTimeoutMs);
  timer.unref?.();
  const snapshot = await initialSnapshot!.finally(() => clearTimeout(timer));
  if (snapshot instanceof DirectProtocolError) {
    queue.close();
    throw snapshot;
  }
  return { ...connection, snapshot, cut: () => ({ snapshot: current ?? snapshot, ordinal }) };
}
