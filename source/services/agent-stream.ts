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
import type { RunTerminationCause } from '../contracts/run-termination.js';

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
  /** Provider-reported input usage from the latest completed request in this run. */
  latestProviderInputTokens?: number;
  /** Cumulative model-request cost records for the run, when the runner records them. */
  runCostRecords?: unknown[];
  /** Logical run outcome, even when the provider returned a valid response. */
  terminalCause?: RunTerminationCause;
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
      event.type === 'model_attempt_rollback' ||
      event.type === 'codex_rate_limits' ||
      event.type === 'tool_call_streaming_delta' ||
      event.type === 'context_compaction_started' ||
      event.type === 'context_compaction_completed' ||
      event.type === 'usage_update' ||
      event.type === 'cost_update' ||
      event.type === 'run_budget'
    ) {
      return [];
    }
    return [item];
  });
}

/**
 * ApplicationRunEvent kinds that outputPush() (application-run-loop.ts) can
 * push into stream.output/newItems without any committed model output or
 * externally effectful action ever occurring -- pure telemetry/lifecycle
 * bookkeeping. Traced by grepping every outputPush call site in
 * application-run-loop.ts: run_budget evidence and the context_compaction_*
 * lifecycle events are pushed unconditionally as soon as they occur,
 * independent of whether the request produced anything. codex_rate_limits is
 * quota metadata, not model content. Every other event outputPush ever
 * pushes (text_delta, reasoning_delta, tool_call_streaming_delta, item,
 * tool_call_dispatched) carries either streamed model output or a real
 * dispatched/committed item, so this list is deliberately exhaustive rather
 * than heuristic -- treat any type not on it as committed.
 *
 * This is the raw-array counterpart to isCommittedOutputEvent
 * (conversation-events.ts), which filters the session-layer ConversationEvent
 * stream for the same purpose; both share the codex_rate_limits and
 * context_compaction_* exclusions. This list omits usage_update, cost_update,
 * subagent_run_budget, and background_check_in_due -- those are either
 * queued directly (queue.push, not outputPush: usage_update) or synthesized
 * only at the session layer above this raw array (cost_update,
 * subagent_run_budget, background_check_in_due), so they can never appear in
 * stream.output/newItems in the first place.
 */
const BOOKKEEPING_ONLY_RUN_EVENT_TYPES: ReadonlySet<string> = new Set([
  'codex_rate_limits',
  'context_compaction_started',
  'context_compaction_completed',
  'context_compaction_failed',
  'run_budget',
]);

function hasCommittedRunEvent(items: readonly unknown[]): boolean {
  return items.some((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return true;
    const type = (item as Record<string, unknown>).type;
    // An item with no recognizable `type` field is not one of the known
    // bookkeeping shapes; treat it as committed rather than risk a false
    // negative that would allow an unsafe replay.
    return typeof type !== 'string' || !BOOKKEEPING_ONLY_RUN_EVENT_TYPES.has(type);
  });
}

/**
 * True when stream.output or stream.newItems holds anything beyond pure
 * bookkeeping -- i.e. the run may have produced user-visible or externally
 * meaningful work that an automatic replay must not duplicate. Used by
 * retry-classifier.ts's "never replay after committed output" guard so a
 * run_budget or context_compaction_* event alone (queued even for a request
 * that failed before streaming anything) does not block otherwise-safe
 * recovery.
 */
export function streamHasCommittedOutput(stream: Pick<AgentStream, 'output' | 'newItems'>): boolean {
  const output = Array.isArray(stream.output) ? stream.output : [];
  const newItems = Array.isArray(stream.newItems) ? stream.newItems : [];
  return hasCommittedRunEvent(output) || hasCommittedRunEvent(newItems);
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
