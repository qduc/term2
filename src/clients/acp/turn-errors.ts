import type { IdleStateUpdate } from '@agentclientprotocol/sdk/experimental/v2';
import type { WireError, WireTerminal } from '../../protocol/wire.js';
import { errorMessage, type AcpLogger, type PromptOutcome } from './contract.js';

const statusMessages = {
  '401': ['authentication', 'The model provider rejected the credentials. Check your provider credentials in Term2.'],
  '402': [
    'insufficient_balance',
    'The model provider rejected the request due to insufficient balance. Check your provider billing.',
  ],
  '403': [
    'permission_denied',
    'The model provider denied access. Check whether your account can use the selected model.',
  ],
  '404': [
    'model_not_found',
    'The model provider could not find the requested resource. Check the selected model and provider URL.',
  ],
  '502': ['provider_unavailable', 'The model provider gateway is unavailable. Try again later.'],
  '503': ['provider_unavailable', 'The model provider is temporarily unavailable. Try again later.'],
  '504': ['provider_timeout', 'The model provider did not respond in time. Try again later.'],
} as const;

const kindMessages = {
  authentication: 'The model provider could not authenticate the request. Check your provider credentials in Term2.',
  context_overflow:
    'The request exceeded the model context window. Compact the session or select a model with a larger context window.',
  invalid_request: 'The model provider rejected the request. Check the selected model and its settings.',
  network: 'Term2 could not connect to the model provider. Check your connection and provider URL.',
  rate_limit: 'The model provider rate limit was reached. Wait before trying again.',
} as const;

/** Classify public failures using fixed messages so provider text and private response data stay local. */
function turnError(error?: WireError): NonNullable<PromptOutcome['error']> {
  const status = error?.message.match(/^(\d{3})(?:\s|:|$)/)?.[1];
  let kind = error ? 'provider' : 'internal';
  let message = error
    ? 'The model provider failed to complete the turn. See Term2 logs for details.'
    : 'Term2 could not complete the turn. See Term2 logs for details.';
  let retryable = error?.retryable === true;

  if (error?.kind === 'context_overflow') {
    kind = error.kind;
    message = kindMessages.context_overflow;
  } else if (error && (status === '402' || /\binsufficient[_ -](?:balance|credits)\b/i.test(error.message))) {
    [kind, message] = statusMessages['402'];
    retryable = false;
  } else if (status && Object.hasOwn(statusMessages, status)) {
    [kind, message] = statusMessages[status as keyof typeof statusMessages];
  } else if (error && /\b(?:insufficient[_ -]quota|exceeded your current quota)\b/i.test(error.message)) {
    kind = 'insufficient_quota';
    message = 'The model provider account has insufficient quota. Check your provider plan and billing.';
    retryable = false;
  } else if (error && Object.hasOwn(kindMessages, error.kind)) {
    kind = error.kind;
    message = kindMessages[error.kind as keyof typeof kindMessages];
  } else if (error?.message === 'OpenAI-compatible streamed response ended without a finish reason') {
    kind = 'incomplete_response';
    message = 'The model provider ended the response before it was complete.';
  }

  return { code: -32603, message, data: { kind, retryable } };
}

/** Snapshot and live terminals produce the same public prompt outcome. */
export function terminalOutcome(terminal: Pick<WireTerminal, 'outcome' | 'error'>): PromptOutcome {
  if (terminal.outcome === 'cancelled' || terminal.outcome === 'interrupted') return { stopReason: 'cancelled' };
  if (terminal.outcome === 'failed') return { stopReason: 'error', error: turnError(terminal.error) };
  return { stopReason: 'end_turn' };
}

/** Keep unexpected execution exceptions local and preserve explicit cancellation. */
export function failedExecution(
  logger: AcpLogger,
  sessionId: string,
  signal: AbortSignal,
  error: unknown,
): PromptOutcome {
  if (signal.aborted) return { stopReason: 'cancelled' };
  logger.error('Direct ACP prompt execution failed', {
    eventType: 'acp.prompt.failed',
    sessionId,
    errorMessage: errorMessage(error),
  });
  return terminalOutcome({ outcome: 'failed' });
}

/** Current ACP v2 clients read error; the pinned experimental SDK preserves the metadata copy. */
export function idleUpdate(outcome: PromptOutcome): IdleStateUpdate & {
  readonly sessionUpdate: 'state_update';
  readonly state: 'idle';
  readonly error?: PromptOutcome['error'];
} {
  return {
    sessionUpdate: 'state_update',
    state: 'idle',
    stopReason: outcome.stopReason,
    ...(outcome.error ? { error: outcome.error, _meta: { term2: { error: outcome.error } } } : {}),
  };
}
