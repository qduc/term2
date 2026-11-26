/**
 * One session's connection, checkpoint and current snapshot. It folds every direct-wire-v2 frame with the shared
 * fold (generated/wire-fold.js) and owns no transcript rule: present.ts turns its snapshot into the view.
 * Transitions follow docs/plans/web-client/web-transcript-single-source-spec.md, section 2.4.
 *
 * The first `snapshot` frame is the page load; it is the only way a cut is installed. Accepted frames at or
 * before the installed seq are ignored; live frames never move the checkpoint. A frame that cannot be parsed or
 * folded, an unavailable replay, or HTTP 410 ends in "Reload required", with no automatic retry.
 */
import { term2Client, Term2ApiError } from '../api/term2';
import { reduceWireEvent, type WireEvent, type WireSnapshot } from './generated/wire-fold.js';
import { present, type PresentConnection, type PresentInteractions } from './present';
import { decodeSseText } from './sse';
import type { InteractionProjection, Term2ConnectionStatus, Term2SessionView } from './types';

const MAX_RECONNECT_DELAY = 10_000;
const BACKOFF_BASE = 500;
const HIDDEN_FLUSH_MS = 500;
const FRAME_RING = 200;

type PendingEntry = Exclude<InteractionProjection, null | { state: 'unavailable' }>;
type Frame = {
  readonly format: 'direct-wire-v2';
  readonly kind: 'accepted' | 'live' | 'snapshot';
  readonly sessionId: string;
  readonly seq?: number | null;
  readonly events: readonly WireEvent[];
  readonly interactions?: Readonly<Record<string, PendingEntry>>;
};

class FrameError extends Error {}

function parseFrame(data: string, sessionId: string): Frame {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    throw new FrameError('A session frame is not JSON.');
  }
  const frame = value as Partial<Frame> | null;
  if (!frame || typeof frame !== 'object' || frame.format !== 'direct-wire-v2')
    throw new FrameError('A session frame has another format.');
  if (frame.sessionId !== sessionId) throw new FrameError('A session frame belongs to another session.');
  if (frame.kind !== 'accepted' && frame.kind !== 'live' && frame.kind !== 'snapshot')
    throw new FrameError('A session frame has an unknown kind.');
  if (!Array.isArray(frame.events) || frame.events.some((event) => event?.sessionId !== sessionId))
    throw new FrameError('A session frame carries events of another session.');
  if (frame.kind === 'accepted' && (typeof frame.seq !== 'number' || !Number.isSafeInteger(frame.seq) || frame.seq < 1))
    throw new FrameError('An accepted frame has no accepted seq.');
  if (frame.kind === 'snapshot' && frame.events.at(-1)?.type !== 'snapshot')
    throw new FrameError('A snapshot frame does not end in its snapshot.');
  return frame as Frame;
}

/** Overlays the hook sets for its own requests (a send in flight, an abort); the next accepted frame clears them. */
export type StoreOverlay = { readonly status?: Term2ConnectionStatus; readonly error?: string | null };

export class Term2SessionStore {
  readonly sessionId: string;
  #snapshot: WireSnapshot | null = null;
  #interactions = new Map<string, PendingEntry>();
  #connection: PresentConnection = { phase: 'idle', error: null };
  #held = false;
  #overlay: StoreOverlay = {};
  #view: Term2SessionView;
  #listeners = new Set<() => void>();
  #controller: AbortController | null = null;
  #flushFrame: number | null = null;
  #flushTimer: ReturnType<typeof setTimeout> | null = null;
  #retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** With diagnostics on, the last frames received (for the diagnostics panel only; nothing reads state from it). */
  readonly frames: unknown[] | null;

  constructor(sessionId: string, options: { diagnostics?: boolean } = {}) {
    this.sessionId = sessionId;
    this.frames = options.diagnostics ? [] : null;
    this.#view = this.#present();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  getView = (): Term2SessionView => this.#view;
  get snapshot(): WireSnapshot | null {
    return this.#snapshot;
  }

  /** Opens the stream; reconnects with backoff until closed or a reload is required. */
  start(): void {
    if (this.#controller) return;
    this.#controller = new AbortController();
    void this.#run(this.#controller.signal);
  }
  /** Explicit reload: drop the stream and connect with no cursor, so the next snapshot frame is a fresh cut. */
  refresh(): void {
    this.close();
    this.#connection = { phase: 'connecting', error: null };
    this.#snapshot = null;
    this.#interactions.clear();
    this.#held = false;
    this.#publish(true);
    this.#controller = null;
    this.start();
  }
  close(): void {
    this.#controller?.abort();
    this.#controller = null;
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    this.#cancelFlush();
  }

  setOverlay(overlay: StoreOverlay): void {
    this.#overlay = { ...this.#overlay, ...overlay };
    this.#publish(true);
  }
  /** A multi-question step answered: the server sent the same request's next DTO. */
  replaceInteractionById(interactionId: string, entry: PendingEntry): void {
    for (const [requestId, known] of this.#interactions)
      if (known.interaction.interactionId === interactionId) this.#interactions.set(requestId, entry);
    this.#publish(true);
  }

  #present(): Term2SessionView {
    const view = present(
      this.sessionId,
      this.#snapshot,
      this.#interactions as PresentInteractions,
      this.#connection,
      this.#view,
    );
    const overlay = this.#overlay;
    return overlay.status || overlay.error !== undefined
      ? { ...view, ...(overlay.status ? { status: overlay.status } : {}), ...(overlay.error !== undefined ? { error: overlay.error } : {}) }
      : view;
  }
  #cancelFlush(): void {
    if (this.#flushFrame !== null && typeof window !== 'undefined') window.cancelAnimationFrame(this.#flushFrame);
    if (this.#flushTimer !== null) clearTimeout(this.#flushTimer);
    this.#flushFrame = null;
    this.#flushTimer = null;
  }
  #flush = (): void => {
    this.#cancelFlush();
    this.#view = this.#present();
    for (const listener of [...this.#listeners]) listener();
  };
  /** Publishes at most once per animation frame while visible; `now` publishes at once (accepted boundaries). */
  #publish(now = false): void {
    if (this.#held) return;
    if (now || typeof window === 'undefined') return this.#flush();
    if (typeof document !== 'undefined' && document.hidden) {
      this.#flushTimer ??= setTimeout(this.#flush, HIDDEN_FLUSH_MS);
      return;
    }
    this.#flushFrame ??= window.requestAnimationFrame(this.#flush);
  }

  /** Applies one frame; returns false when the frame was ignored (an older cut). */
  apply(frame: Frame): boolean {
    this.frames?.push(frame);
    if (this.frames && this.frames.length > FRAME_RING) this.frames.splice(0, this.frames.length - FRAME_RING);
    const installed = this.#snapshot?.seq ?? null;
    if (frame.kind === 'snapshot') {
      const cut = frame.seq ?? null;
      if (installed !== null && cut !== null && cut < installed) return false;
      let state = this.#snapshot;
      for (const event of frame.events)
        state = event.type === 'snapshot' ? event.payload.snapshot : state ? reduceWireEvent(state, event) : state;
      this.#snapshot = state;
      this.#interactions = new Map(Object.entries(frame.interactions ?? {}));
      this.#held = false;
      this.#overlay = {};
      this.#connection = { ...this.#connection, phase: 'live', error: null };
      this.#publish(true);
      return true;
    }
    if (!this.#snapshot) throw new FrameError('A frame arrived before the session snapshot.');
    if (frame.kind === 'accepted' && installed !== null && frame.seq! <= installed) return false;
    let state = this.#snapshot;
    for (const event of frame.events) state = reduceWireEvent(state, event);
    if (frame.kind === 'accepted') {
      state = { ...state, seq: frame.seq! };
      for (const [requestId, entry] of Object.entries(frame.interactions ?? {})) this.#interactions.set(requestId, entry);
      const pending = new Set([
        ...state.pendingInteractions.map((request) => request.requestId),
        ...(state.pendingBudgets ?? []).map((request) => request.requestId),
      ]);
      for (const requestId of [...this.#interactions.keys()]) if (!pending.has(requestId)) this.#interactions.delete(requestId);
      this.#overlay = {};
      // Until the snapshot that follows a history replacement, the fold is stale by design: publish nothing.
      if (frame.events.some((event) => event.type === 'history_replaced' && !event.payload.retainTranscript))
        this.#held = true;
    }
    this.#snapshot = state;
    this.#publish(frame.kind === 'accepted');
    return true;
  }

  async #run(signal: AbortSignal): Promise<void> {
    let delay = BACKOFF_BASE;
    this.#connection = { phase: 'connecting', error: null };
    this.#publish(true);
    while (!signal.aborted) {
      try {
        const cursor = this.#snapshot?.seq ?? null;
        const response = await term2Client.openDirectEvents(this.sessionId, cursor, signal);
        const replay = response.data.headers.get('x-term2-replay');
        if (replay !== 'atomic') {
          await response.data.body?.cancel();
          return this.#reloadRequired('Replay of this session is unavailable. Reload to load its current state.');
        }
        this.#connection = { ...this.#connection, replayMode: 'atomic' };
        const reader = response.data.body?.getReader();
        if (!reader) throw new Error('The session stream has no body.');
        const decoder = new TextDecoder();
        let carry = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done || signal.aborted) break;
          const decoded = decodeSseText(decoder.decode(value, { stream: true }), carry);
          carry = decoded.carry;
          for (const sse of decoded.frames) {
            try {
              this.apply(parseFrame(sse.data, this.sessionId));
            } catch (error) {
              // A frame the fold refuses (another session, a broken envelope) is not a connection problem.
              throw error instanceof FrameError ? error : new FrameError('A session frame could not be folded.');
            }
            delay = BACKOFF_BASE;
          }
        }
        if (signal.aborted) return;
        // The stream ended: reconnect from the checkpoint.
        this.#connection = { ...this.#connection, phase: 'reconnecting' };
        this.#publish(true);
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof FrameError)
          return this.#reloadRequired('The session stream sent something this page cannot read. Reload to continue.');
        if (error instanceof Term2ApiError) {
          if (error.status === 410 || error.code === 'cursor_compacted' || error.code === 'replay_unavailable')
            return this.#reloadRequired('This session can no longer be resumed from here. Reload to load its current state.');
          if ([401, 403, 404].includes(error.status)) {
            this.#connection = { phase: 'closed', error: error.message };
            this.#publish(true);
            return;
          }
        }
        this.#connection = { ...this.#connection, phase: 'reconnecting', error: 'Connection interrupted; retrying.' };
        this.#publish(true);
      }
      await new Promise<void>((resolve) => {
        this.#retryTimer = setTimeout(resolve, delay);
      });
      delay = Math.min(MAX_RECONNECT_DELAY, delay * 2);
    }
  }
  #reloadRequired(message: string): void {
    this.#controller?.abort();
    this.#connection = { ...this.#connection, phase: 'reload_required', error: message };
    this.#held = false;
    this.#publish(true);
  }
}
