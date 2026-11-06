/** Legacy's live notice lines for compaction and retries, folded into the snapshot. */
import type { WireEvent, WireSnapshot } from './wire.js';

export const COMPACTION_NOTICE = 'context_compaction';
export const COMPACTING = 'Compacting context...';

export function compactionOutcome(
  state: WireSnapshot,
  event: Extract<WireEvent, { type: 'compaction_completed' | 'compaction_failed' }>,
): WireSnapshot {
  const index = state.notices
    .map((notice) => notice.kind === COMPACTION_NOTICE && notice.message === COMPACTING)
    .lastIndexOf(true);
  if (index === -1) return state;
  const seconds = event.payload.durationMs > 0 ? ` (${(event.payload.durationMs / 1000).toFixed(1)}s)` : '';
  const before = event.payload.requests.find((request) => request.usage)?.usage?.inputTokens;
  const message =
    event.type === 'compaction_completed'
      ? event.payload.strategy === 'native' && before !== undefined
        ? `Compacted from ${before.toLocaleString('en-US')} tokens${seconds}.`
        : `Compacted context${seconds}.`
      : event.payload.failure.kind === 'failed' || event.payload.failure.kind === 'blocked'
      ? 'Context compaction failed (request). The turn continues with the full context.'
      : undefined;
  const notices = state.notices.slice();
  if (message === undefined) notices.splice(index, 1);
  else notices[index] = { kind: COMPACTION_NOTICE, message };
  return { ...state, notices };
}

export const ENDS_RETRY: ReadonlySet<string> = new Set([
  'text_delta',
  'reasoning_delta',
  'tool_call_streaming_delta',
  'tool_called',
  'turn_ended',
]);

/** Legacy's upstream retry line (conversation-event-handler.ts). */
function retryMessage(retry: Extract<WireEvent, { type: 'retrying' }>['payload']): string {
  if (retry.retryType === 'connection_interrupted')
    return `Connection was interrupted before the response completed. Rebuilding context and retrying... (Attempt ${
      retry.attempt
    }/${retry.maxRetries ?? '?'})`;
  const prefix =
    retry.error.kind === 'network'
      ? 'Network connection unavailable'
      : retry.error.kind === 'rate_limit'
      ? 'Rate limited'
      : retry.error.kind === 'provider'
      ? 'Provider unavailable'
      : 'Upstream error';
  return `${prefix} — retrying ${retry.attempt}/${retry.maxRetries ?? '?'} in ${Math.ceil(retry.delayMs / 1000)}s`;
}

/** Legacy's retry line, plus the live countdown its working indicator shows. */
export function retrying(state: WireSnapshot, event: Extract<WireEvent, { type: 'retrying' }>): WireSnapshot {
  const { attempt, maxRetries, delayMs } = event.payload;
  return {
    ...state,
    notices: [...state.notices, { kind: 'retrying', message: retryMessage(event.payload) }],
    ...(maxRetries !== undefined ? { retry: { id: state.notices.length, attempt, maxRetries, delayMs } } : {}),
  };
}
