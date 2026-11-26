/** Direct wire SSE is snapshot+live, not a second journal. SSE IDs are actual durable cursors when the
 * supplied direct connection supports Session captureFrom; null cursors have no ID. The gateway's
 * historical agent-wire envelope still needs enrichment; x-term2-event-format is explicit.
 */
import type { DirectConnection, DirectReplayConnection } from './in-process-direct-types.js';
import type { WireEventBatch } from './in-process-direct-queue.js';
import type { ServerInteraction, ServerInteractions } from './server-interactions.js';
import { snapshotEvent } from '../protocol/state.js';
import type { WireBudgetRequest, WireEvent, WireInteraction, WireSnapshot } from '../protocol/wire.js';
import type { AgentWireV2Envelope } from './server-wire-v2.js';
import type { ServerResult } from './server-contracts.js';

const SERVER_EVENT_HEARTBEAT_INTERVAL_MS = 15_000;
// Containment for a subscriber that stops reading. These limits detach only the network
// subscriber: durable Session work and future attachments remain intact. A full socket buffer
// (write() returning false) is ordinary backpressure during a burst, not evidence of a dead
// reader, so every frame write waits for drain. A subscriber whose frame writes have stayed
// backpressured for DRAIN_TIMEOUT_MS in total is detached: that covers a reader that stopped and
// one that keeps reading but slower than the Session emits, and bounds the queued backlog to
// roughly DRAIN_TIMEOUT_MS of output. A write that is accepted below the buffer limit resets it.
const DRAIN_TIMEOUT_MS = 10_000;
const MAX_BUFFERED_EVENTS = 256;
type StreamFrame = {
  readonly id: number | null;
  readonly event?: 'accepted' | 'live' | 'snapshot';
  readonly data: unknown;
};
/** What a stream sends: single events (direct-wire-v1, agent-wire-v2) or publication batches (direct-wire-v2). */
type StreamSource<U> = {
  readonly format: 'direct-wire-v1' | 'agent-wire-v2' | typeof DIRECT_WIRE_V2;
  /** V2 accepted frames retain their real accepted seq even when replay is unavailable. */
  readonly acceptedIds?: boolean;
  /** Whether a connection with no cursor starts with a snapshot frame. */
  readonly snapshot: boolean;
  readonly units: () => AsyncIterable<U>;
  /**
   * The frames that open a no-cursor connection, read once at the live cut, and which units the opening
   * snapshot already contains (they are not sent again).
   */
  readonly open: () => { readonly first: readonly U[]; readonly contained?: (unit: U) => boolean };
  /** How much of the reconnect buffer a unit uses: its events, not its frames. */
  readonly size: (unit: U) => number;
  encode(unit: U): StreamFrame | null;
};
/** Owns attachment cleanup only. Backpressure never cancels the Session or blocks its execution. */
export function directEventStream(connection: DirectConnection | DirectReplayConnection): ServerResult {
  return eventStream(connection, {
    format: 'direct-wire-v1',
    snapshot: true,
    units: () => connection.events,
    open: () => ({
      first: connection.snapshot
        ? [
            {
              sessionId: connection.sessionId,
              seq: connection.snapshot.seq,
              turnId: null,
              type: 'snapshot',
              payload: { snapshot: connection.snapshot },
            } as WireEvent,
          ]
        : [],
    }),
    size: () => 1,
    encode: (event) => ({ id: event.seq, data: event }),
  });
}
export function agentWireV2EventStream(
  connection: DirectConnection | DirectReplayConnection,
  encode: (event: WireEvent) => AgentWireV2Envelope | null,
): ServerResult {
  return eventStream(connection, {
    format: 'agent-wire-v2',
    snapshot: false,
    acceptedIds: true,
    units: () => connection.events,
    open: () => ({ first: [] }),
    size: () => 1,
    encode(event) {
      const envelope = encode(event);
      if (!envelope) return null;
      return {
        id: envelope.kind === 'accepted' ? envelope.seq : null,
        event: envelope.kind,
        data: envelope,
      };
    },
  });
}
/**
 * direct-wire-v2 (server-wire-direct.ts): native events, one frame per Session publication. A connection with no
 * cursor opens with the current snapshot and then sends only publications after it; with a cursor it sends the
 * accepted tail, the replay's snapshot, then live frames. Null when this connection cannot report batches.
 */
export function directWireV2EventStream(
  connection: DirectConnection | DirectReplayConnection,
  interactions: ServerInteractions,
): ServerResult | null {
  const batches = connection.batches;
  const cut = 'cut' in connection ? connection.cut : undefined;
  if (!batches || (!('replay' in connection) && !cut)) return null;
  return eventStream<WireEventBatch>(connection, {
    format: DIRECT_WIRE_V2,
    snapshot: true,
    acceptedIds: true,
    units: batches,
    open() {
      if (!cut) return { first: [] };
      const { snapshot, ordinal } = cut();
      return { first: [{ ...snapshotBatch(snapshot), ordinal }], contained: (batch) => batch.ordinal <= ordinal };
    },
    // An empty accepted frame still costs a frame; count it as one.
    size: (batch) => Math.max(1, batch.events.length),
    encode(batch) {
      const envelope = directWireV2Frame(connection.sessionId, batch, interactions);
      return { id: envelope.kind === 'live' ? null : envelope.seq, event: envelope.kind, data: envelope };
    },
  });
}
function eventStream<U>(
  connection: DirectConnection | DirectReplayConnection,
  encoding: StreamSource<U>,
): ServerResult {
  const replay = 'replay' in connection ? connection.replay : null;
  const resumable =
    replay !== null || (encoding.snapshot && connection.snapshot !== null && connection.snapshot.seq !== null);

  return {
    status: 200,
    body: null,
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'x-term2-event-format': encoding.format,
      'x-term2-event-mode': replay ? 'replay-live' : encoding.snapshot ? 'snapshot-live' : 'live',
      'x-term2-replay': resumable ? 'atomic' : 'unavailable',
      ...(replay ? { 'x-term2-replay-from': String(replay.fromSeq), 'x-term2-replay-to': String(replay.toSeq) } : {}),
    },
    stream: {
      close: () => connection.close(),
      async start(response, request) {
        let closed = false;
        let live = false;
        let heartbeat: ReturnType<typeof setInterval> | undefined;
        let releaseClose!: () => void;
        const whenClosed = new Promise<void>((resolve) => {
          releaseClose = resolve;
        });
        const buffered: U[] = [];
        let bufferedSize = 0;
        let contained: ((unit: U) => boolean) | undefined;
        const close = () => {
          if (closed) return;
          closed = true;
          if (heartbeat) clearInterval(heartbeat);
          response.off('close', close);
          request.off('aborted', disconnect);
          connection.close();
          releaseClose();
        };
        const disconnect = () => {
          response.destroy();
          close();
        };
        response.once('close', close);
        request.once('aborted', disconnect);
        if (response.destroyed || request.aborted) {
          disconnect();
          return;
        }
        // A comment establishes the downstream BFF/browser stream immediately.
        // Headers alone can remain buffered by an HTTP streaming proxy until
        // the first body byte; v2 has no initial snapshot event to provide it.
        if (!response.write(': connected\n\n')) {
          disconnect();
          return;
        }
        const write = (unit: U): boolean => {
          if (closed || response.destroyed || response.writableEnded) return false;
          const frame = encoding.encode(unit);
          // Folded read-model updates are not SSE frames and consume no numeric cursor.
          if (!frame) return true;
          const eventLine = frame.event ? `event: ${frame.event}\n` : '';
          const idLine = (resumable || encoding.acceptedIds) && frame.id !== null ? `id: ${frame.id}\n` : '';
          return response.write(`${eventLine}${idLine}data: ${JSON.stringify(frame.data)}\n\n`);
        };
        const waitForDrain = (timeoutMs = DRAIN_TIMEOUT_MS) =>
          new Promise<void>((resolve) => {
            const done = () => {
              clearTimeout(timer);
              response.off('drain', done);
              response.off('close', done);
              resolve();
            };
            const timer = setTimeout(() => {
              disconnect();
              done();
            }, Math.max(0, timeoutMs));
            response.once('drain', done);
            response.once('close', done);
            if (response.destroyed) done();
          });
        // When frame writes first stopped fitting the buffer; null once a write fits again.
        let backpressuredSince: number | null = null;
        const writeDraining = async (unit: U) => {
          if (contained?.(unit)) return;
          if (write(unit)) {
            backpressuredSince = null;
            return;
          }
          if (closed) return;
          backpressuredSince ??= Date.now();
          await waitForDrain(DRAIN_TIMEOUT_MS - (Date.now() - backpressuredSince));
        };
        // Consume during snapshot drain so this transport's backlog is bounded. This is only a
        // transient subscriber queue; it is never persisted or used as a reconnect authority.
        const pump = (async () => {
          for await (const unit of encoding.units()) {
            if (closed) break;
            // A replay tail is (fromSeq,toSeq] only; never prepend a current snapshot.
            if (replay || live) await writeDraining(unit);
            else if (bufferedSize + encoding.size(unit) <= MAX_BUFFERED_EVENTS) {
              buffered.push(unit);
              bufferedSize += encoding.size(unit);
            } else {
              disconnect();
              break;
            }
          }
        })().catch(() => {
          disconnect();
        });
        try {
          if (encoding.snapshot && !replay) {
            const opening = encoding.open();
            for (const unit of opening.first) await writeDraining(unit);
            // From here on, skip what the opening snapshot already holds (not the opening frames themselves).
            contained = opening.contained;
          }
          while (!closed && buffered.length) await writeDraining(buffered.shift()!);
          if (closed) return;
          // No await at the empty-buffer/live-cut boundary.
          live = true;
          heartbeat = setInterval(() => {
            if (!closed && !response.write(`: heartbeat ${new Date().toISOString()}\n\n`)) void waitForDrain();
          }, SERVER_EVENT_HEARTBEAT_INTERVAL_MS);
          heartbeat.unref?.();
          await Promise.race([pump, whenClosed]);
        } finally {
          close();
          if (!response.destroyed && !response.writableEnded) response.end();
        }
      },
    },
  };
}

/**
 * The direct-wire-v2 event format: native WireEvents, unchanged, in one frame per Session publication.
 *
 *   { format, kind: 'accepted', sessionId, seq, occurredAt, events, interactions? }   one accepted fact
 *   { format, kind: 'live',     sessionId,                   events }                 one live transient
 *   { format, kind: 'snapshot', sessionId, seq,              events, interactions }   a cut; last event is the snapshot
 *
 * A client folds every event with the shared fold (src/protocol/fold/) and owns no reducer. `interactions` are the
 * answerable DTOs (the resolver contract) for requests opened in that frame, or pending at that snapshot; whether
 * a request is still pending is read from the folded snapshot, so closing needs no entry. See
 * docs/plans/web-client/web-transcript-single-source-spec.md, section 2.1.
 */
export const DIRECT_WIRE_V2 = 'direct-wire-v2';

/** A pending request as the browser answers it; the same shape the hydration GET returns. */
export type PendingInteractionEntry = {
  readonly state: 'pending';
  readonly interaction: ServerInteraction;
  readonly turnId: string;
  readonly subagent?: { readonly agentId: string; readonly role: string; readonly name?: string };
};
export type PendingInteractionEntries = Readonly<Record<string, PendingInteractionEntry>>;

export type DirectWireV2Envelope =
  | {
      readonly format: typeof DIRECT_WIRE_V2;
      readonly kind: 'accepted';
      readonly sessionId: string;
      readonly seq: number;
      readonly occurredAt: string | null;
      readonly events: readonly WireEvent[];
      readonly interactions?: PendingInteractionEntries;
    }
  | {
      readonly format: typeof DIRECT_WIRE_V2;
      readonly kind: 'live';
      readonly sessionId: string;
      readonly events: readonly WireEvent[];
    }
  | {
      readonly format: typeof DIRECT_WIRE_V2;
      readonly kind: 'snapshot';
      readonly sessionId: string;
      readonly seq: number | null;
      readonly events: readonly WireEvent[];
      readonly interactions: PendingInteractionEntries;
    };

type Owner = { readonly agentId: string; readonly role?: string };

/** The answerable DTO for one pending request. A task-owned request names its subagent. */
export function pendingInteractionEntry(
  interactions: ServerInteractions,
  sessionId: string,
  request: { readonly interaction: WireInteraction; readonly owner?: Owner } | { readonly budget: WireBudgetRequest },
): PendingInteractionEntry {
  if ('budget' in request)
    return { state: 'pending', interaction: interactions.projectBudget(request.budget), turnId: request.budget.turnId };
  const { interaction, owner } = request;
  const taskOwner = interaction.taskOwner;
  const subagent = taskOwner
    ? { agentId: taskOwner.id, role: taskOwner.role ?? 'subagent', ...(taskOwner.name ? { name: taskOwner.name } : {}) }
    : owner
    ? { agentId: owner.agentId, role: owner.role ?? 'subagent' }
    : undefined;
  return {
    state: 'pending',
    interaction: interactions.project(sessionId, interaction),
    turnId: interaction.turnId,
    ...(subagent ? { subagent } : {}),
  };
}

/** Every request pending at a snapshot, built from that snapshot so the DTOs and the state are one cut. */
function snapshotInteractions(interactions: ServerInteractions, snapshot: WireSnapshot): PendingInteractionEntries {
  const entries: Record<string, PendingInteractionEntry> = {};
  for (const interaction of snapshot.pendingInteractions)
    entries[interaction.requestId] = pendingInteractionEntry(interactions, snapshot.sessionId, { interaction });
  for (const budget of snapshot.pendingBudgets ?? [])
    entries[budget.requestId] = pendingInteractionEntry(interactions, snapshot.sessionId, { budget });
  return entries;
}

/** Requests opened by the events of one accepted frame, root or inside a subagent. */
function openedInteractions(interactions: ServerInteractions, events: readonly WireEvent[]): PendingInteractionEntries {
  const entries: Record<string, PendingInteractionEntry> = {};
  const visit = (event: WireEvent, owner?: Owner): void => {
    if (event.type === 'interaction_opened')
      entries[event.payload.interaction.requestId] = pendingInteractionEntry(interactions, event.sessionId, {
        interaction: event.payload.interaction,
        ...(owner ? { owner } : {}),
      });
    else if (event.type === 'budget_opened')
      entries[event.payload.request.requestId] = pendingInteractionEntry(interactions, event.sessionId, {
        budget: event.payload.request,
      });
    else if (event.type === 'subagent')
      visit(event.payload.event, {
        agentId: event.payload.agentId,
        ...(event.payload.role ? { role: event.payload.role } : {}),
      });
  };
  for (const event of events) visit(event);
  return entries;
}

/** The frame for one batch. Throws when an answerable DTO cannot be built: the stream fails, it never skips. */
function directWireV2Frame(
  sessionId: string,
  batch: Pick<WireEventBatch, 'kind' | 'seq' | 'occurredAt' | 'events'>,
  interactions: ServerInteractions,
): DirectWireV2Envelope {
  for (const event of batch.events)
    if (event.sessionId !== sessionId) throw new Error('A direct-wire-v2 batch holds another session');
  if (batch.kind === 'live') return { format: DIRECT_WIRE_V2, kind: 'live', sessionId, events: batch.events };
  if (batch.kind === 'snapshot') {
    const last = batch.events.at(-1);
    if (last?.type !== 'snapshot') throw new Error('A direct-wire-v2 snapshot frame must end in its snapshot');
    return {
      format: DIRECT_WIRE_V2,
      kind: 'snapshot',
      sessionId,
      seq: last.payload.snapshot.seq,
      events: batch.events,
      interactions: snapshotInteractions(interactions, last.payload.snapshot),
    };
  }
  if (batch.seq === null || !Number.isSafeInteger(batch.seq) || batch.seq < 1)
    throw new Error('A direct-wire-v2 accepted frame needs a positive accepted seq');
  const opened = openedInteractions(interactions, batch.events);
  return {
    format: DIRECT_WIRE_V2,
    kind: 'accepted',
    sessionId,
    seq: batch.seq,
    occurredAt: batch.occurredAt,
    events: batch.events,
    ...(Object.keys(opened).length ? { interactions: opened } : {}),
  };
}

/** The first frame of a connection with no cursor: the current snapshot, as a snapshot frame. */
function snapshotBatch(snapshot: WireSnapshot): Pick<WireEventBatch, 'kind' | 'seq' | 'occurredAt' | 'events'> {
  return {
    kind: 'snapshot',
    seq: snapshot.seq,
    occurredAt: null,
    events: [snapshotEvent(snapshot)],
  };
}
