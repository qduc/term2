/** Native payload validation; envelope sequencing and the only writer stay in log.ts. */
import { isDirectQueueFactType, parseDirectQueueFact, directContentSchema } from './queue-decode.js';
import { isDirectContextFactType, parseDirectContextFact } from './context.js';
import { isDirectCommandFactType, parseDirectCommandFact } from './command-receipts.js';
import { isDirectNotificationFactType, parseDirectNotificationFact } from './notifications.js';
import { parseDirectConfigurationFact } from './configuration.js';
import { nativeSchemas } from './log-fact-native-schemas.js';

function objectRecord(value: unknown, fail: (field: string) => never, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(field);
  return value as Record<string, unknown>;
}

export function validateRequestConfiguration(value: unknown, fail: (field: string) => never): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail('requestConfiguration');
  const configuration = value as Record<string, unknown>;
  const allowed = new Set(['provider', 'model', 'reasoningEffort', 'mode']);
  if (Object.keys(configuration).some((key) => !allowed.has(key))) fail('requestConfiguration');
  const text = (field: 'provider' | 'model' | 'mode'): void => {
    if (typeof configuration[field] !== 'string' || configuration[field] === '') fail(`requestConfiguration.${field}`);
  };
  text('provider');
  text('model');
  text('mode');
  const effort = configuration['reasoningEffort'];
  if (effort !== null && (typeof effort !== 'string' || effort.length === 0))
    fail('requestConfiguration.reasoningEffort');
}

/** Unknown vocabulary still fails instead of disappearing during replay. */
export function isKnownDirectFactType(type: string): boolean {
  return (
    type === 'configuration_changed' ||
    Object.hasOwn(nativeSchemas, type) ||
    isDirectQueueFactType(type) ||
    isDirectContextFactType(type) ||
    isDirectCommandFactType(type) ||
    isDirectNotificationFactType(type)
  );
}

/** Validate hydrated current-format facts; physical payload references are decoded first. */
export function validateFact(fact: Record<string, unknown>, where: string): void {
  const type = String(fact['type']);
  if (isDirectQueueFactType(type)) {
    // The parser returns the original fact, so queue_settled.preservePendingSteers survives.
    parseDirectQueueFact(fact);
    return;
  }
  if (isDirectContextFactType(type)) {
    parseDirectContextFact(fact);
    return;
  }
  if (isDirectCommandFactType(type)) {
    parseDirectCommandFact(fact);
    return;
  }
  if (isDirectNotificationFactType(type)) {
    parseDirectNotificationFact(fact);
    return;
  }
  if (type === 'configuration_changed') {
    // Parser returns the original fact. Replay must not rebuild or apply it.
    parseDirectConfigurationFact(fact);
    return;
  }
  const check = factValidation(fact, where);
  if (
    'modelStep' in fact &&
    (typeof fact['modelStep'] !== 'number' || !Number.isSafeInteger(fact['modelStep']) || fact['modelStep'] < 0)
  ) {
    check.fail('modelStep');
  }
  if (typeof fact['type'] === 'string' && Object.hasOwn(nativeSchemas, type)) nativeSchemas[type]!(fact, check, where);
}

function factValidation(fact: Record<string, unknown>, where: string): FactValidation {
  const fail: (field: string) => never = (field) => {
    throw new Error(`${where}: invalid ${String(fact['type'])}.${field}`);
  };
  const text = (value: unknown, field: string): void => {
    if (typeof value !== 'string' || value.length === 0) fail(field);
  };
  const optionalText = (record: Record<string, unknown>, field: string): void => {
    if (field in record) text(record[field], field);
  };
  const object = (value: unknown, field: string): Record<string, unknown> => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(field);
    return value as Record<string, unknown>;
  };
  const hasInput = (record: Record<string, unknown>): void => {
    if (!('input' in record)) fail('input');
  };
  const result = (value: unknown): void => {
    const record = object(value, 'result');
    if (typeof record['output'] !== 'string' || typeof record['isError'] !== 'boolean') fail('result');
    if ('providerOutput' in record) {
      if (!Array.isArray(record['providerOutput'])) fail('result.providerOutput');
      for (const part of record['providerOutput'] as unknown[]) object(part, 'result.providerOutput[]');
    }
    // Accepted audit only. Replay must not treat this as a live root stop.
    if ('stopAfterExecution' in record && record['stopAfterExecution'] !== true) fail('result.stopAfterExecution');
  };
  const resolution = (value: unknown): void => {
    const record = object(value, 'resolution');
    switch (record['kind']) {
      case 'allow':
        if ('grant' in record && typeof record['grant'] !== 'string') fail('resolution.grant');
        break;
      case 'cancelled':
      case 'interrupted':
        break;
      case 'deny':
        if ('reason' in record && typeof record['reason'] !== 'string') fail('resolution.reason');
        break;
      case 'answer':
        if (typeof record['answer'] !== 'string') fail('resolution.answer');
        break;
      default:
        fail('resolution.kind');
    }
    if ('stopAfterApprovalResolution' in record && typeof record['stopAfterApprovalResolution'] !== 'boolean') {
      fail('resolution.stopAfterApprovalResolution');
    }
  };
  return { fail, text, optionalText, object, hasInput, result, resolution };
}

export type FactValidation = {
  fail: (field: string) => never;
  text: (value: unknown, field: string) => void;
  optionalText: (record: Record<string, unknown>, field: string) => void;
  object: (value: unknown, field: string) => Record<string, unknown>;
  hasInput: (record: Record<string, unknown>) => void;
  result: (value: unknown) => void;
  resolution: (value: unknown) => void;
};
export type FactSchema = (fact: Record<string, unknown>, check: FactValidation, where: string) => void;

export function validateModelRef(value: unknown, fail: (field: string) => never, field: string): void {
  const model = objectRecord(value, fail, field);
  for (const key of ['provider', 'model'])
    if (typeof model[key] !== 'string' || model[key] === '') fail(`${field}.${key}`);
}

export function validateModelError(value: unknown, fail: (field: string) => never, field: string): void {
  const error = objectRecord(value, fail, field);
  if (
    typeof error['message'] !== 'string' ||
    typeof error['retryable'] !== 'boolean' ||
    ![
      'authentication',
      'rate_limit',
      'network',
      'context_overflow',
      'invalid_request',
      'provider',
      'cancelled',
    ].includes(error['kind'] as string)
  )
    fail(field);
}

export function validateProviderCost(value: unknown, fail: (field: string) => never, field: string): void {
  if (
    (typeof value !== 'number' && typeof value !== 'string') ||
    (typeof value === 'string' && !value.trim()) ||
    !Number.isFinite(Number(value)) ||
    Number(value) < 0
  )
    fail(field);
}

/** Validate lifecycle evidence in place: never default or normalize missing metrics. */
export function validateCompactionFact(fact: Record<string, unknown>, fail: (field: string) => never): void {
  const exact = (
    record: Record<string, unknown>,
    required: readonly string[],
    optional: readonly string[],
    field: string,
  ): void => {
    if (
      required.some((key) => !(key in record)) ||
      Object.keys(record).some((key) => !required.includes(key) && !optional.includes(key))
    )
      fail(field);
  };
  const number = (value: unknown, field: string): void => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) fail(field);
  };
  const text = (value: unknown, field: string): void => {
    if (typeof value !== 'string' || value === '') fail(field);
  };
  const strategy = (value: unknown): void => {
    if (value !== 'native' && value !== 'local') fail('strategy');
  };
  const model = (value: unknown, field: string): void => {
    validateModelRef(value, fail, field);
    exact(objectRecord(value, fail, field), ['provider', 'model'], [], field);
  };
  const estimate = (value: unknown, field: string): void => {
    const record = objectRecord(value, fail, field);
    const keys = ['renderedInputTokens', 'outputReserveTokens', 'safetyReserveTokens', 'hardFitTokens'];
    exact(record, keys, [], field);
    for (const key of keys) number(record[key], `${field}.${key}`);
  };
  text(fact['turnId'], 'turnId');
  text(fact['compactionId'], 'compactionId');
  if (fact['type'] === 'compaction_started') {
    exact(
      fact,
      ['type', 'turnId', 'compactionId', 'trigger', 'model', 'before'],
      ['strategy', 'contextWindow', 'maxRequestInputTokens', 'lastCompletedInputTokens'],
      'payload',
    );
    if (fact['trigger'] !== 'manual' && fact['trigger'] !== 'automatic') fail('trigger');
    model(fact['model'], 'model');
    estimate(fact['before'], 'before');
    if ('strategy' in fact) strategy(fact['strategy']);
    for (const key of ['contextWindow', 'lastCompletedInputTokens']) if (key in fact) number(fact[key], key);
    if ('maxRequestInputTokens' in fact && fact['maxRequestInputTokens'] !== null)
      number(fact['maxRequestInputTokens'], 'maxRequestInputTokens');
    return;
  }
  const completed = fact['type'] === 'compaction_completed';
  exact(
    fact,
    ['type', 'turnId', 'compactionId', 'durationMs', 'requests', ...(completed ? ['strategy', 'after'] : ['failure'])],
    [],
    'payload',
  );
  // Monotonic elapsed time can be fractional; the log clock has no role here.
  number(fact['durationMs'], 'durationMs');
  if (!Array.isArray(fact['requests'])) fail('requests');
  const requestIds = new Set<string>();
  for (const value of fact['requests'] as unknown[]) {
    const request = objectRecord(value, fail, 'requests[]');
    exact(request, ['requestId', 'modelStep', 'model', 'outcome'], ['usage', 'costUsd'], 'requests[]');
    text(request['requestId'], 'requests.requestId');
    const requestId = request['requestId'] as string;
    if (requestIds.has(requestId)) fail('requests.requestId');
    requestIds.add(requestId);
    const step = request['modelStep'];
    if (typeof step !== 'number' || !Number.isSafeInteger(step) || step < 0) fail('requests.modelStep');
    model(request['model'], 'requests.model');
    if (!['completed', 'failed', 'cancelled'].includes(request['outcome'] as string)) fail('requests.outcome');
    if ('usage' in request) {
      const usage = objectRecord(request['usage'], fail, 'requests.usage');
      const keys = ['inputTokens', 'outputTokens', 'cachedInputTokens'];
      exact(usage, keys, [], 'requests.usage');
      for (const key of keys) number(usage[key], `requests.usage.${key}`);
    }
    if ('costUsd' in request) validateProviderCost(request['costUsd'], fail, 'requests.costUsd');
  }
  if (completed) {
    strategy(fact['strategy']);
    estimate(fact['after'], 'after');
    return;
  }
  const failure = objectRecord(fact['failure'], fail, 'failure');
  switch (failure['kind']) {
    case 'blocked':
      exact(failure, ['kind', 'reason'], [], 'failure');
      if (
        ![
          'disabled',
          'unknown_threshold',
          'native_unavailable',
          'unsettled_tools',
          'no_complete_cold_turn',
          'single_turn_too_large',
          'opaque_context',
          'summary_input_too_large',
          'non_reducing',
          'result_still_too_large',
        ].includes(failure['reason'] as string)
      )
        fail('failure.reason');
      break;
    case 'interrupted':
      exact(failure, ['kind', 'reason'], [], 'failure');
      if (failure['reason'] !== 'budget_wrap_up' && failure['reason'] !== 'budget_exhausted') fail('failure.reason');
      break;
    case 'cancelled':
      exact(failure, ['kind'], [], 'failure');
      break;
    case 'failed': {
      exact(failure, ['kind', 'error'], [], 'failure');
      validateModelError(failure['error'], fail, 'failure.error');
      const error = objectRecord(failure['error'], fail, 'failure.error');
      exact(error, ['kind', 'message', 'retryable'], ['retryAfterMs'], 'failure.error');
      if ('retryAfterMs' in error) number(error['retryAfterMs'], 'failure.error.retryAfterMs');
      break;
    }
    default:
      fail('failure.kind');
  }
}

/** Validate new explicit replacement/branch payloads without normalizing provider-native data. */
export function validateHistory(value: unknown, where: string): void {
  if (!Array.isArray(value)) throw new Error(`${where}: history/input must be an array`);
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.id !== 'string' || !item.id)
      throw new Error(`${where}: invalid history item`);
    switch (item.type) {
      case 'user_message':
      case 'assistant_message':
        directContentSchema.parse(item.content);
        break;
      case 'tool_call':
        if (
          typeof item.callId !== 'string' ||
          !item.callId ||
          typeof item.toolName !== 'string' ||
          !item.toolName ||
          !('input' in item)
        )
          throw new Error(`${where}: invalid tool call`);
        break;
      case 'tool_result':
        if (
          typeof item.callId !== 'string' ||
          !item.callId ||
          typeof item.output !== 'string' ||
          typeof item.isError !== 'boolean' ||
          'stopAfterExecution' in item
        )
          throw new Error(`${where}: invalid tool result`);
        break;
      case 'summary':
        if (
          typeof item.text !== 'string' ||
          !Array.isArray(item.replaces) ||
          !item.replaces.every((id: unknown) => typeof id === 'string')
        )
          throw new Error(`${where}: invalid summary`);
        break;
      case 'reasoning':
        if (typeof item.summary !== 'string') throw new Error(`${where}: invalid reasoning`);
        break;
      case 'provider_opaque':
      case 'provider_input': {
        const data = item.type === 'provider_opaque' ? item.item : item.input;
        if (typeof item.provider !== 'string' || !data || typeof data !== 'object' || Array.isArray(data))
          throw new Error(`${where}: invalid provider item`);
        break;
      }
      default:
        throw new Error(`${where}: unknown history item ${String(item.type)}`);
    }
  }
}

/** Budget audit is data only: decoding does not instantiate a live budget or grant extensions. */
export function validateBudgetEvidence(value: unknown, where: string): void {
  const invalid = (): never => {
    throw new Error(`${where}: invalid budget evidence`);
  };
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const event = value as Record<string, unknown>;
  const finite = (number: unknown): number => {
    if (typeof number !== 'number' || !Number.isFinite(number)) return invalid();
    return number;
  };
  switch (event['type']) {
    case 'budget_stage': {
      if (!['soft', 'warning', 'critical'].includes(event['stage'] as string)) invalid();
      const raw = event['evidence'];
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid();
      const evidence = raw as Record<string, unknown>;
      if (!['usd', 'unpriced_tokens', 'active_time', 'turns'].includes(evidence['dimension'] as string)) invalid();
      if (finite(evidence['used']) < 0 || finite(evidence['limit']) < 0) invalid();
      finite(evidence['headroom']);
      break;
    }
    case 'tool_stall':
      if (typeof event['toolName'] !== 'string' || !event['toolName'] || typeof event['argumentsText'] !== 'string')
        invalid();
      for (const field of ['count', 'threshold']) {
        const number = finite(event[field]);
        if (!Number.isSafeInteger(number) || number < 1) invalid();
      }
      break;
    default:
      invalid();
  }
}

/** Validate the clean ModelRequestCost/NormalizedUsage data without repricing or stripping extensions. */
export function validateRequestCost(value: unknown, where: string): void {
  const fail: (field: string) => never = (field) => {
    throw new Error(`${where}: invalid request cost ${field}`);
  };
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('record');
  const record = value as Record<string, unknown>;
  for (const field of ['requestId', 'provider', 'model'])
    if (typeof record[field] !== 'string' || !record[field]) fail(field);
  if (!['standard', 'flex', 'batch', 'unknown'].includes(record['serviceTier'] as string)) fail('serviceTier');
  if (!['completed', 'failed', 'cancelled'].includes(record['outcome'] as string)) fail('outcome');
  // Provider charges can include credits. Integer micros are signed, not a catalog-rate constraint.
  if ('usdMicros' in record && (typeof record['usdMicros'] !== 'number' || !Number.isSafeInteger(record['usdMicros'])))
    fail('usdMicros');
  if ('source' in record && record['source'] !== 'provider' && record['source'] !== 'catalog') fail('source');
  for (const field of ['pricingVersion', 'pricedFromProvider'])
    if (field in record && typeof record[field] !== 'string') fail(field);
  if (
    'unpricedReason' in record &&
    !['missing_usage', 'unknown_provider', 'unknown_model', 'unknown_tier', 'ambiguous_usage'].includes(
      record['unpricedReason'] as string,
    )
  )
    fail('unpricedReason');
  if ('usage' in record) {
    const raw = record['usage'];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('usage');
    const usage = raw as Record<string, unknown>;
    for (const field of [
      'prompt_tokens',
      'completion_tokens',
      'total_tokens',
      'reasoning_tokens',
      'cache_read_tokens',
      'cache_creation_tokens',
      'prompt_ms',
      'completion_ms',
      'tokens_per_second',
      'ttft_ms',
    ])
      if (field in usage && (typeof usage[field] !== 'number' || !Number.isFinite(usage[field])))
        fail(`usage.${field}`);
    for (const field of ['tokens_per_second_estimated', 'tokens_per_second_burst'])
      if (field in usage && typeof usage[field] !== 'boolean') fail(`usage.${field}`);
    if ('upstream_provider' in usage && typeof usage['upstream_provider'] !== 'string') fail('usage.upstream_provider');
  }
}
