/**
 * Application-owned stream handle consumed by the conversation/session layer.
 *
 * Provider adapters may back this with any runtime implementation, but the
 * session layer only relies on this small surface: events can be iterated,
 * terminal state can be observed, and the accumulated turn snapshots remain
 * available for replay/finalization.  Keeping continuation state opaque here
 * prevents the session layer from depending on a provider runner's type.
 */
import type { ContinuationHandle } from '../contracts/continuation-handle.js';
import type { ApplicationRunEvent } from '../contracts/application-stream.js';

const APPLICATION_STREAM = Symbol('application-stream');

type UnbrandedAgentStream = Omit<AgentStream, typeof APPLICATION_STREAM>;

export interface AgentStream {
  readonly [APPLICATION_STREAM]: true;
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
  /** Cumulative model-request cost records for the run, when the runner records them. */
  runCostRecords?: unknown[];
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

/** Return whether a value is the application-owned stream representation. */
export function isAgentStream(value: unknown): value is AgentStream {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Partial<Record<typeof APPLICATION_STREAM, unknown>>)[APPLICATION_STREAM] === true
  );
}

/** Assert that a value is the application-owned stream representation. */
export function assertAgentStream(value: unknown): asserts value is AgentStream {
  if (!isAgentStream(value)) throw new TypeError('Expected a branded AgentStream');
}

/** Construct the only branded application stream representation. */
export function createAgentStream(stream: UnbrandedAgentStream): AgentStream {
  return Object.defineProperty(stream, APPLICATION_STREAM, {
    value: true,
    enumerable: false,
    writable: false,
  }) as AgentStream;
}
