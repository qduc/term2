/** Native payload validation; envelope sequencing and the only writer stay in log.ts. */
import {
  isDirectQueueFactType,
  parseDirectQueueFact,
  validDirectQueueOrigin,
  directContentSchema,
} from './direct-queue-decode.js';
import { isDirectContextFactType, parseDirectContextFact } from './direct-context.js';
import { isDirectCommandFactType, parseDirectCommandFact } from './direct-command-receipts.js';
import { isDirectNotificationFactType, parseDirectNotificationFact } from './direct-notifications.js';
import { parseDirectConfigurationFact } from './direct-configuration.js';

/** Same identity the store requires before it will write session_started.rolloverFrom. */
const directSessionId = /^conv_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function validateRequestConfiguration(value: unknown, fail: (field: string) => never): void {
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

const nativeTypes = new Set([
  'session_started',
  'turn_started',
  'text_delta',
  'item',
  'tool_started',
  'tool_finished',
  'interaction_opened',
  'interaction_closed',
  'usage',
  'turn_ended',
  'history_replaced',
  'model_response_completed',
  'request_cost_recorded',
  'budget_opened',
  'budget_closed',
  'budget_observed',
  'branch_started',
  'branch_event',
  'task_started',
  'task_backgrounded',
  'task_stop_requested',
  'task_finished',
  'task_interaction_opened',
  'task_interaction_closed',
  'configuration_changed',
]);

/** Unknown vocabulary still fails instead of disappearing during replay. */
export function isKnownDirectFactType(type: string): boolean {
  return (
    nativeTypes.has(type) ||
    isDirectQueueFactType(type) ||
    isDirectContextFactType(type) ||
    isDirectCommandFactType(type) ||
    isDirectNotificationFactType(type)
  );
}

/** Validate additive direct facts without changing the v1 envelope or M1 payload rules. */
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
  const fail = (field: string): never => {
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
  };
  const resolution = (value: unknown): void => {
    const record = object(value, 'resolution');
    switch (record['kind']) {
      case 'allow':
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

  if (
    'modelStep' in fact &&
    (typeof fact['modelStep'] !== 'number' || !Number.isSafeInteger(fact['modelStep']) || fact['modelStep'] < 0)
  ) {
    fail('modelStep');
  }
  switch (fact['type']) {
    case 'session_started': {
      optionalText(fact, 'forkedFrom');
      if (
        'rolloverFrom' in fact &&
        (typeof fact['rolloverFrom'] !== 'string' || !directSessionId.test(fact['rolloverFrom']))
      )
        fail('rolloverFrom');
      if ('workspaceIdentity' in fact) {
        const workspace = object(fact['workspaceIdentity'], 'workspaceIdentity');
        text(workspace['root'], 'workspaceIdentity.root');
        text(workspace['target'], 'workspaceIdentity.target');
        if (workspace['access'] !== 'read' && workspace['access'] !== 'read_write') fail('workspaceIdentity.access');
      }
      if ('binding' in fact) {
        const binding = object(fact['binding'], 'binding');
        text(binding['client'], 'binding.client');
        text(binding['id'], 'binding.id');
      }
      break;
    }
    case 'turn_started': {
      if ('requestConfiguration' in fact) validateRequestConfiguration(fact['requestConfiguration'], fail);
      const silent = 'silent' in fact;
      if (silent && fact['silent'] !== true) fail('silent');
      if ('retryContext' in fact) {
        const retryContext = object(fact['retryContext'], 'retryContext');
        const keys = Object.keys(retryContext);
        if (keys.length !== 2 || !keys.includes('sourceTurnId') || !keys.includes('throughItemId'))
          fail('retryContext');
        text(retryContext['sourceTurnId'], 'retryContext.sourceTurnId');
        text(retryContext['throughItemId'], 'retryContext.throughItemId');
        if (silent) fail('silent');
        if ('submission' in fact) fail('submission');
        if (!Array.isArray(fact['input']) || fact['input'].length !== 0) fail('input');
      } else if (silent) {
        if ('submission' in fact) fail('submission');
        if (!Array.isArray(fact['input']) || fact['input'].length === 0) fail('input');
      }
      if (!('submission' in fact)) break;
      const submission = object(fact['submission'], 'submission');
      text(submission['clientRequestId'], 'submission.clientRequestId');
      text(submission['messageId'], 'submission.messageId');
      if ('origin' in submission) {
        const origin = object(submission['origin'], 'submission.origin');
        if (!validDirectQueueOrigin(origin)) fail('submission.origin');
      }
      const input = fact['input'];
      if (!Array.isArray(input)) fail('input');
      // Correlation must identify this admission's user input, not an assistant,
      // an earlier turn's message or metadata that only happens to reuse the ID.
      if (
        !(input as unknown[]).some((item) => {
          if (typeof item !== 'object' || item === null || Array.isArray(item)) return false;
          const record = item as Record<string, unknown>;
          return record['type'] === 'user_message' && record['id'] === submission['messageId'];
        })
      ) {
        fail('submission.messageId');
      }
      break;
    }
    case 'item': {
      if ('executionId' in fact) {
        text(fact['executionId'], 'executionId');
        const item = object(fact['item'], 'item');
        if (item['type'] !== 'tool_call' && item['type'] !== 'tool_result') fail('executionId');
      }
      break;
    }
    case 'tool_started':
      text(fact['turnId'], 'turnId');
      text(fact['executionId'], 'executionId');
      optionalText(fact, 'parentExecutionId');
      if (fact['parentExecutionId'] === fact['executionId']) fail('parentExecutionId');
      text(fact['callId'], 'callId');
      text(fact['toolName'], 'toolName');
      hasInput(fact);
      break;
    case 'tool_finished':
      text(fact['turnId'], 'turnId');
      text(fact['executionId'], 'executionId');
      result(fact['result']);
      break;
    case 'interaction_opened': {
      text(fact['turnId'], 'turnId');
      const request = object(fact['request'], 'request');
      text(request['requestId'], 'request.requestId');
      text(request['turnId'], 'request.turnId');
      if (request['turnId'] !== fact['turnId']) fail('request.turnId');
      if (request['kind'] !== 'approval' && request['kind'] !== 'question') fail('request.kind');
      text(request['toolName'], 'request.toolName');
      if (typeof request['summary'] !== 'string') fail('request.summary');
      if ('detail' in request && typeof request['detail'] !== 'string') fail('request.detail');
      optionalText(request, 'executionId');
      optionalText(request, 'parentExecutionId');
      optionalText(request, 'sourceCallId');
      if (
        'risk' in request &&
        request['risk'] !== 'low' &&
        request['risk'] !== 'medium' &&
        request['risk'] !== 'high'
      ) {
        fail('request.risk');
      }
      if ('presentation' in request) object(request['presentation'], 'request.presentation');
      hasInput(request);
      break;
    }
    case 'interaction_closed':
      text(fact['turnId'], 'turnId');
      text(fact['requestId'], 'requestId');
      resolution(fact['resolution']);
      if ('resolutionSource' in fact && !['user', 'policy', 'system'].includes(fact['resolutionSource'] as string))
        fail('resolutionSource');
      if ('automaticApproval' in fact && typeof fact['automaticApproval'] !== 'boolean') fail('automaticApproval');
      break;
    case 'history_replaced':
      optionalText(fact, 'turnId');
      if (!['compaction', 'retry_turn', 'retry_tool', 'rewind'].includes(fact['reason'] as string)) fail('reason');
      validateHistory(fact['history'], where);
      if (
        'rearmAtEstimatedTokens' in fact &&
        (typeof fact['rearmAtEstimatedTokens'] !== 'number' ||
          !Number.isFinite(fact['rearmAtEstimatedTokens']) ||
          fact['rearmAtEstimatedTokens'] < 0)
      )
        fail('rearmAtEstimatedTokens');
      if (
        'checkpointReceipts' in fact &&
        (!Array.isArray(fact['checkpointReceipts']) ||
          !fact['checkpointReceipts'].every((value) => typeof value === 'string'))
      )
        fail('checkpointReceipts');
      break;
    case 'model_response_completed':
      text(fact['turnId'], 'turnId');
      if (!('modelStep' in fact)) fail('modelStep');
      if (!['end_turn', 'tool_use', 'max_tokens', 'refusal'].includes(fact['stopReason'] as string)) fail('stopReason');
      if ('providerMetadata' in fact) object(fact['providerMetadata'], 'providerMetadata');
      if ('costUsd' in fact) {
        const cost = fact['costUsd'];
        if (
          (typeof cost !== 'number' && typeof cost !== 'string') ||
          (typeof cost === 'string' && !cost.trim()) ||
          !Number.isFinite(Number(cost)) ||
          Number(cost) < 0
        )
          fail('costUsd');
      }
      break;
    case 'request_cost_recorded':
      text(fact['turnId'], 'turnId');
      text(fact['rootTurnId'], 'rootTurnId');
      optionalText(fact, 'parentTurnId');
      validateRequestCost(fact['record'], where);
      break;
    case 'budget_opened': {
      text(fact['turnId'], 'turnId');
      text(fact['requestId'], 'requestId');
      validateBudgetEvidence(fact['evidence'], where);
      const snapshot = object(fact['snapshot'], 'snapshot');
      for (const field of ['pricedUsdMicros', 'unpricedTokens', 'activeTimeMs', 'turns', 'extensionsGranted']) {
        const value = snapshot[field];
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) fail(`snapshot.${field}`);
      }
      if (
        !Array.isArray(snapshot['latchedStages']) ||
        !snapshot['latchedStages'].every((stage) => ['soft', 'warning', 'critical'].includes(stage))
      )
        fail('snapshot.latchedStages');
      break;
    }
    case 'budget_closed': {
      text(fact['turnId'], 'turnId');
      text(fact['requestId'], 'requestId');
      if (!['user', 'parent', 'system'].includes(fact['source'] as string)) fail('source');
      const decision = object(fact['decision'], 'decision');
      switch (decision['kind']) {
        case 'extend':
          if (decision['grantedBy'] !== 'human' && decision['grantedBy'] !== 'parent') fail('decision.grantedBy');
          break;
        case 'stop':
          break;
        case 'steer':
          validateHistory(decision['items'], where);
          break;
        default:
          fail('decision.kind');
      }
      break;
    }
    case 'budget_observed':
      text(fact['turnId'], 'turnId');
      validateBudgetEvidence(fact['evidence'], where);
      break;
    case 'turn_ended':
      if (!['completed', 'cancelled', 'failed', 'interrupted'].includes(fact['outcome'] as string)) fail('outcome');
      if (
        'terminalCause' in fact &&
        !['goal_check_unresolved', 'completion_verification_blocked', 'budget_exhausted'].includes(
          fact['terminalCause'] as string,
        )
      )
        fail('terminalCause');
      if ('notice' in fact && typeof fact['notice'] !== 'string') fail('notice');
      break;
    case 'branch_started':
      optionalText(fact, 'parentTurnId');
      optionalText(fact, 'rootTurnId');
      text(fact['branchId'], 'branchId');
      text(fact['taskId'], 'taskId');
      text(fact['turnId'], 'turnId');
      validateHistory(fact['input'], where);
      break;
    case 'branch_event': {
      text(fact['branchId'], 'branchId');
      const inner = object(fact['fact'], 'fact');
      if (
        ![
          'text_delta',
          'item',
          'tool_started',
          'tool_finished',
          'usage',
          'turn_ended',
          'history_replaced',
          'model_response_completed',
          'budget_opened',
          'budget_closed',
          'budget_observed',
        ].includes(inner['type'] as string)
      )
        fail('fact.type');
      if (inner['type'] === 'history_replaced' && !inner['turnId']) fail('fact.turnId');
      validateFact(inner, `${where}.branch`);
      break;
    }
    case 'task_started': {
      const task = object(fact['task'], 'task');
      for (const field of ['taskId', 'sessionId', 'parentTurnId']) text(task[field], `task.${field}`);
      if (typeof task['label'] !== 'string' || !['shell', 'subagent'].includes(task['kind'] as string)) fail('task');
      if (!['foreground', 'background'].includes(fact['mode'] as string)) fail('mode');
      if (typeof task['startedAt'] !== 'number' || !Number.isFinite(task['startedAt']) || task['startedAt'] < 0)
        fail('task.startedAt');
      for (const field of ['name', 'role', 'parentExecutionId', 'sourceCallId']) optionalText(task, field);
      if ('origin' in task && !validDirectQueueOrigin(task['origin'])) fail('task.origin');
      if ('model' in task) {
        const model = object(task['model'], 'task.model');
        text(model['provider'], 'model.provider');
        text(model['model'], 'model.model');
      }
      if ('workspace' in task) {
        const workspace = object(task['workspace'], 'task.workspace');
        text(workspace['root'], 'workspace.root');
        text(workspace['target'], 'workspace.target');
        if (workspace['access'] !== 'read' && workspace['access'] !== 'read_write') fail('workspace.access');
      }
      // Absent input stays unknown. An empty string is not an original task.
      if ('input' in task && (typeof task['input'] !== 'string' || task['input'].length === 0)) fail('task.input');
      break;
    }
    case 'task_backgrounded':
    case 'task_stop_requested':
    case 'task_finished': {
      text(fact['taskId'], 'taskId');
      if (typeof fact['at'] !== 'number' || !Number.isFinite(fact['at']) || fact['at'] < 0) fail('at');
      if (fact['type'] === 'task_finished') {
        const result = object(fact['result'], 'result');
        if (!['completed', 'cancelled', 'failed', 'budget_exhausted', 'interrupted'].includes(result['kind'] as string))
          fail('result.kind');
        if (result['kind'] === 'interrupted') text(result['reason'], 'result.reason');
        const value = result['value'];
        if (typeof value === 'object' && value !== null && !Array.isArray(value) && 'toolsUsed' in value) {
          const toolsUsed = (value as Record<string, unknown>)['toolsUsed'];
          if (!Array.isArray(toolsUsed)) fail('result.value.toolsUsed');
          const seen = new Set<string>();
          for (const name of toolsUsed) {
            if (typeof name !== 'string' || name.length === 0 || seen.has(name)) fail('result.value.toolsUsed');
            seen.add(name);
          }
        }
        if (result['kind'] === 'failed') {
          const error = object(result['error'], 'result.error');
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
            fail('result.error');
        }
      }
      break;
    }
    case 'task_interaction_opened': {
      const request = object(fact['request'], 'request');
      text(request['taskId'], 'request.taskId');
      text(request['sessionId'], 'request.sessionId');
      if ('origin' in request && !validDirectQueueOrigin(request['origin'])) fail('request.origin');
      validateFact({ type: 'interaction_opened', turnId: request['turnId'], request }, where);
      break;
    }
    case 'task_interaction_closed': {
      text(fact['taskId'], 'taskId');
      text(fact['requestId'], 'requestId');
      const value = object(fact['resolution'], 'resolution');
      if (value['kind'] === 'decision') {
        const decision = object(value['decision'], 'resolution.decision');
        if (!['allow', 'deny', 'answer'].includes(decision['kind'] as string)) fail('resolution.decision.kind');
        resolution(decision);
      } else if (value['kind'] !== 'cancelled' && value['kind'] !== 'interrupted') fail('resolution.kind');
      break;
    }
  }
}

/** Validate new explicit replacement/branch payloads without normalizing provider-native data. */
function validateHistory(value: unknown, where: string): void {
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
          typeof item.isError !== 'boolean'
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
function validateBudgetEvidence(value: unknown, where: string): void {
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
function validateRequestCost(value: unknown, where: string): void {
  const fail = (field: string): never => {
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
