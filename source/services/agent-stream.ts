/**
 * Application-owned stream handle consumed by the conversation/session layer.
 *
 * Provider adapters may back this with any runtime implementation, but the
 * session layer only relies on this small surface: events can be iterated,
 * terminal state can be observed, and the accumulated turn snapshots remain
 * available for replay/finalization.  Keeping continuation state opaque here
 * prevents the session layer from depending on a provider runner's type.
 */
import { createContinuationHandle, type ContinuationHandle } from '../contracts/continuation-handle.js';

export interface AgentStream {
  [Symbol.asyncIterator](): AsyncIterator<unknown>;

  completed: Promise<unknown>;
  history: unknown[];
  newItems: unknown[];
  output: unknown[];
  finalOutput?: string;
  lastResponseId?: string | null;
  interruptions?: unknown[];
  /** Opaque for new callers; legacy approval persistence still carries it through. */
  state?: ContinuationHandle;
  cancelled?: boolean;
  rawResponses?: unknown[];
  /** Authoritative cumulative usage for the run, exposed separately from opaque continuation state. */
  runUsage?: unknown;
}

/** Select current-run terminal items when available, falling back to full history. */
export function selectAgentStreamItems(stream: Pick<AgentStream, 'output' | 'newItems' | 'history'>): unknown[] {
  const output = Array.isArray(stream.output) ? stream.output : [];
  const newItems = Array.isArray(stream.newItems) ? stream.newItems : [];
  const history = Array.isArray(stream.history) ? stream.history : [];
  return newItems.length > 0 ? newItems : output.length > 0 ? output : history;
}

/** Adapt a provider/runtime stream to the app-owned stream contract. */
export function adaptAgentStream(source: unknown): AgentStream {
  const stream = source as Record<string | symbol, any>;
  // Read legacy raw state only at the runtime boundary. Once wrapped, callers
  // consume the explicit app-owned usage field and never reopen opaque state.
  const legacyRunUsage = stream.state?.usage;
  const state = stream.state === undefined ? undefined : createContinuationHandle(stream.state);
  return {
    [Symbol.asyncIterator]: () => stream[Symbol.asyncIterator](),
    get completed() {
      return stream.completed;
    },
    get history() {
      return stream.history;
    },
    get newItems() {
      return stream.newItems;
    },
    get output() {
      return stream.output;
    },
    get finalOutput() {
      return stream.finalOutput;
    },
    get lastResponseId() {
      return stream.lastResponseId;
    },
    get interruptions() {
      return stream.interruptions;
    },
    get cancelled() {
      return stream.cancelled;
    },
    get rawResponses() {
      return stream.rawResponses;
    },
    get runUsage() {
      return stream.runUsage ?? legacyRunUsage;
    },
    state,
  };
}
