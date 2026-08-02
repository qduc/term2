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
import type { ApplicationRunEvent } from '../contracts/application-stream.js';
import { normalizeLegacyAgentEvent, normalizeLegacySnapshotItems } from './legacy-agent-stream-adapter.js';

const APPLICATION_STREAM = Symbol('application-stream');

export interface AgentStream {
  readonly [APPLICATION_STREAM]?: true;
  [Symbol.asyncIterator](): AsyncIterator<ApplicationRunEvent>;

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

/** Select provider items from the current run, falling back to full history. */
export function selectAgentStreamItems(stream: Pick<AgentStream, 'output' | 'newItems' | 'history'>): unknown[] {
  const output = projectProviderItems(Array.isArray(stream.output) ? stream.output : []);
  const newItems = projectProviderItems(Array.isArray(stream.newItems) ? stream.newItems : []);
  const history = Array.isArray(stream.history) ? stream.history : [];
  return newItems.length > 0 ? newItems : output.length > 0 ? output : history;
}

function projectProviderItems(items: readonly unknown[]): unknown[] {
  return items.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const event = item as Record<string, unknown>;
    if (event.type === 'item' && event.item && typeof event.item === 'object') return [event.item];
    if (
      event.type === 'text_delta' ||
      event.type === 'reasoning_delta' ||
      event.type === 'codex_rate_limits' ||
      event.type === 'tool_call_streaming_delta' ||
      event.type === 'usage_update'
    ) {
      return [];
    }
    return [item];
  });
}

/** Adapt a provider/runtime stream to the app-owned stream contract. */
export function adaptAgentStream(source: unknown): AgentStream {
  const stream = source as Record<string | symbol, any>;
  if (stream[APPLICATION_STREAM] === true) return source as AgentStream;
  // Read legacy raw state only at the runtime boundary. Once wrapped, callers
  // consume the explicit app-owned usage field and never reopen opaque state.
  const legacyRunUsage = stream.state?.usage;
  const state = stream.state === undefined ? undefined : createContinuationHandle(stream.state);
  return {
    [APPLICATION_STREAM]: true,
    async *[Symbol.asyncIterator](): AsyncIterator<ApplicationRunEvent> {
      const state = {
        toolNames: new Map<number | string, string>(),
        toolArgumentChars: new Map<number | string, number>(),
      };
      for await (const rawEvent of stream as any) {
        for (const event of normalizeLegacyAgentEvent(rawEvent, state)) yield event;
      }
    },
    get completed() {
      return stream.completed;
    },
    get history() {
      return normalizeLegacySnapshotItems(Array.isArray(stream.history) ? stream.history : []);
    },
    get newItems() {
      return normalizeLegacySnapshotItems(Array.isArray(stream.newItems) ? stream.newItems : []);
    },
    get output() {
      return normalizeLegacySnapshotItems(Array.isArray(stream.output) ? stream.output : []);
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
