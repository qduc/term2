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

function objectRecord(value: unknown, fail: (field: string) => never, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(field);
  return value as Record<string, unknown>;
}

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

type FactValidation = {
  fail: (field: string) => never;
  text: (value: unknown, field: string) => void;
  optionalText: (record: Record<string, unknown>, field: string) => void;
  object: (value: unknown, field: string) => Record<string, unknown>;
  hasInput: (record: Record<string, unknown>) => void;
  result: (value: unknown) => void;
  resolution: (value: unknown) => void;
};
type FactSchema = (fact: Record<string, unknown>, check: FactValidation, where: string) => void;

const validateCompactionSchema: FactSchema = (fact, check) => {
  validateCompactionFact(fact, check.fail);
};

const validateTaskLifecycleSchema: FactSchema = (fact, check: FactValidation) => {
  check.text(fact['taskId'], 'taskId');
  if (typeof fact['at'] !== 'number' || !Number.isFinite(fact['at']) || fact['at'] < 0) check.fail('at');
  if (fact['type'] === 'task_finished') {
    const result = check.object(fact['result'], 'result');
    if (!['completed', 'cancelled', 'failed', 'budget_exhausted', 'interrupted'].includes(result['kind'] as string))
      check.fail('result.kind');
    if (result['kind'] === 'interrupted') check.text(result['reason'], 'result.reason');
    const value = result['value'];
    if (typeof value === 'object' && value !== null && !Array.isArray(value) && 'toolsUsed' in value) {
      const toolsUsed = (value as Record<string, unknown>)['toolsUsed'];
      if (!Array.isArray(toolsUsed)) check.fail('result.value.toolsUsed');
      const seen = new Set<string>();
      for (const name of toolsUsed) {
        if (typeof name !== 'string' || name.length === 0 || seen.has(name)) check.fail('result.value.toolsUsed');
        seen.add(name);
      }
    }
    // Absent stays unknown. [] is an accepted observation of no physical starts.
    // Do not derive counts from toolsUsed, labels, output, or call names.
    if (typeof value === 'object' && value !== null && !Array.isArray(value) && 'toolUseCounts' in value) {
      const toolUseCounts = (value as Record<string, unknown>)['toolUseCounts'];
      if (!Array.isArray(toolUseCounts)) check.fail('result.value.toolUseCounts');
      const seen = new Set<string>();
      for (const entry of toolUseCounts) {
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry))
          check.fail('result.value.toolUseCounts');
        const record = entry as Record<string, unknown>;
        const keys = Object.keys(record);
        if (keys.length !== 2 || !keys.includes('toolName') || !keys.includes('count'))
          check.fail('result.value.toolUseCounts');
        const toolName = record['toolName'];
        const count = record['count'];
        if (typeof toolName !== 'string' || toolName.length === 0 || seen.has(toolName))
          check.fail('result.value.toolUseCounts');
        if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1)
          check.fail('result.value.toolUseCounts');
        seen.add(toolName);
      }
    }
    if (result['kind'] === 'failed') validateModelError(result['error'], check.fail, 'result.error');
  }
};

/** One local validator per fact type; shared shapes delegate without replay side effects. */
const nativeSchemas: Record<string, FactSchema> = {
  transcript_message: (fact, check) => {
    if (Object.keys(fact).some((key) => !['type', 'turnId', 'message'].includes(key))) check.fail('payload');
    check.optionalText(fact, 'turnId');
    const message = check.object(fact['message'], 'message');
    if (Object.keys(message).some((key) => !['id', 'role', 'content', 'presentation'].includes(key)))
      check.fail('message');
    check.text(message['id'], 'message.id');
    if (!['user', 'assistant', 'system', 'tool'].includes(message['role'] as string)) check.fail('message.role');
    directContentSchema.parse(message['content']);
    for (const part of message['content'] as Record<string, unknown>[]) {
      const allowed = part['type'] === 'text' ? ['type', 'text'] : ['type', 'mediaType', 'data', 'detail'];
      if (Object.keys(part).some((key) => !allowed.includes(key))) check.fail('message.content');
    }
    if ('presentation' in message) {
      check.object(message['presentation'], 'message.presentation');
      const json = (value: unknown): boolean =>
        value === null ||
        typeof value === 'string' ||
        typeof value === 'boolean' ||
        (typeof value === 'number' && Number.isFinite(value)) ||
        (Array.isArray(value)
          ? value.every(json)
          : typeof value === 'object' && value !== null && Object.values(value).every(json));
      if (!json(message['presentation'])) check.fail('message.presentation');
    }
  },
  session_started: (fact, check) => {
    check.optionalText(fact, 'forkedFrom');
    if (
      'rolloverFrom' in fact &&
      (typeof fact['rolloverFrom'] !== 'string' || !directSessionId.test(fact['rolloverFrom']))
    )
      check.fail('rolloverFrom');
    if ('workspaceIdentity' in fact) {
      const workspace = check.object(fact['workspaceIdentity'], 'workspaceIdentity');
      check.text(workspace['root'], 'workspaceIdentity.root');
      check.text(workspace['target'], 'workspaceIdentity.target');
      if (workspace['access'] !== 'read' && workspace['access'] !== 'read_write')
        check.fail('workspaceIdentity.access');
    }
    if ('binding' in fact) {
      const binding = check.object(fact['binding'], 'binding');
      check.text(binding['client'], 'binding.client');
      check.text(binding['id'], 'binding.id');
    }
  },
  turn_started: (fact, check) => {
    if ('display' in fact && fact['display'] !== false) check.fail('display');
    if ('requestConfiguration' in fact) validateRequestConfiguration(fact['requestConfiguration'], check.fail);
    const silent = 'silent' in fact;
    if (silent && fact['silent'] !== true) check.fail('silent');
    if ('maintenance' in fact) {
      const maintenance = check.object(fact['maintenance'], 'maintenance');
      const keys = Object.keys(maintenance);
      if (keys.length !== 2 || !keys.includes('kind') || !keys.includes('commandId')) check.fail('maintenance');
      if (maintenance['kind'] !== 'compaction') check.fail('maintenance.kind');
      check.text(maintenance['commandId'], 'maintenance.commandId');
      if (silent || 'retryContext' in fact || 'submission' in fact) check.fail('maintenance');
      if (!Array.isArray(fact['input']) || fact['input'].length !== 0) check.fail('input');
    }
    if ('retryContext' in fact) {
      const retryContext = check.object(fact['retryContext'], 'retryContext');
      const keys = Object.keys(retryContext);
      if (keys.length !== 2 || !keys.includes('sourceTurnId') || !keys.includes('throughItemId'))
        check.fail('retryContext');
      check.text(retryContext['sourceTurnId'], 'retryContext.sourceTurnId');
      check.text(retryContext['throughItemId'], 'retryContext.throughItemId');
      if (silent) check.fail('silent');
      if ('submission' in fact) check.fail('submission');
      if (!Array.isArray(fact['input']) || fact['input'].length !== 0) check.fail('input');
    } else if (silent) {
      if ('submission' in fact) check.fail('submission');
      if (!Array.isArray(fact['input']) || fact['input'].length === 0) check.fail('input');
    }
    if (!('submission' in fact)) return;
    const submission = check.object(fact['submission'], 'submission');
    check.text(submission['clientRequestId'], 'submission.clientRequestId');
    check.text(submission['messageId'], 'submission.messageId');
    if ('origin' in submission) {
      const origin = check.object(submission['origin'], 'submission.origin');
      if (!validDirectQueueOrigin(origin)) check.fail('submission.origin');
    }
    const input = fact['input'];
    if (!Array.isArray(input)) check.fail('input');
    // Correlation must identify this admission's user input, not an assistant,
    // an earlier turn's message or metadata that only happens to reuse the ID.
    if (
      !(input as unknown[]).some((item) => {
        if (typeof item !== 'object' || item === null || Array.isArray(item)) return false;
        const record = item as Record<string, unknown>;
        return record['type'] === 'user_message' && record['id'] === submission['messageId'];
      })
    ) {
      check.fail('submission.messageId');
    }
  },
  item: (fact, check, where) => {
    if ('display' in fact && fact['display'] !== false) check.fail('display');
    validateHistory([fact['item']], where);
    const item = check.object(fact['item'], 'item');
    if (item['type'] === 'tool_result' && 'stopAfterExecution' in item) check.fail('item.stopAfterExecution');
    if ('executionId' in fact) {
      check.text(fact['executionId'], 'executionId');
      if (item['type'] !== 'tool_call' && item['type'] !== 'tool_result') check.fail('executionId');
    }
  },
  tool_started: (fact, check) => {
    check.text(fact['turnId'], 'turnId');
    check.text(fact['executionId'], 'executionId');
    check.optionalText(fact, 'parentExecutionId');
    if (fact['parentExecutionId'] === fact['executionId']) check.fail('parentExecutionId');
    check.text(fact['callId'], 'callId');
    check.text(fact['toolName'], 'toolName');
    check.hasInput(fact);
  },
  tool_finished: (fact, check) => {
    check.text(fact['turnId'], 'turnId');
    check.text(fact['executionId'], 'executionId');
    check.result(fact['result']);
  },
  interaction_opened: (fact, check) => {
    check.text(fact['turnId'], 'turnId');
    const request = check.object(fact['request'], 'request');
    check.text(request['requestId'], 'request.requestId');
    check.text(request['turnId'], 'request.turnId');
    if (request['turnId'] !== fact['turnId']) check.fail('request.turnId');
    if (request['kind'] !== 'approval' && request['kind'] !== 'question') check.fail('request.kind');
    check.text(request['toolName'], 'request.toolName');
    if (typeof request['summary'] !== 'string') check.fail('request.summary');
    if ('detail' in request && typeof request['detail'] !== 'string') check.fail('request.detail');
    check.optionalText(request, 'executionId');
    check.optionalText(request, 'parentExecutionId');
    check.optionalText(request, 'sourceCallId');
    if ('risk' in request && request['risk'] !== 'low' && request['risk'] !== 'medium' && request['risk'] !== 'high') {
      check.fail('request.risk');
    }
    if ('presentation' in request) check.object(request['presentation'], 'request.presentation');
    check.hasInput(request);
  },
  interaction_closed: (fact, check) => {
    check.text(fact['turnId'], 'turnId');
    check.text(fact['requestId'], 'requestId');
    check.resolution(fact['resolution']);
    if ('resolutionSource' in fact && !['user', 'policy', 'system'].includes(fact['resolutionSource'] as string))
      check.fail('resolutionSource');
    if ('automaticApproval' in fact && typeof fact['automaticApproval'] !== 'boolean') check.fail('automaticApproval');
  },
  compaction_started: validateCompactionSchema,
  compaction_completed: validateCompactionSchema,
  compaction_failed: validateCompactionSchema,
  history_replaced: (fact, check, where) => {
    if ('retainTranscript' in fact && fact['retainTranscript'] !== true) check.fail('retainTranscript');
    check.optionalText(fact, 'turnId');
    if ('compactionId' in fact) {
      check.text(fact['compactionId'], 'compactionId');
      check.text(fact['turnId'], 'turnId');
      if (fact['reason'] !== 'compaction') check.fail('compactionId');
    }
    if (!['compaction', 'retry_turn', 'retry_tool', 'rewind'].includes(fact['reason'] as string)) check.fail('reason');
    validateHistory(fact['history'], where);
    if (
      'rearmAtEstimatedTokens' in fact &&
      (typeof fact['rearmAtEstimatedTokens'] !== 'number' ||
        !Number.isFinite(fact['rearmAtEstimatedTokens']) ||
        fact['rearmAtEstimatedTokens'] < 0)
    )
      check.fail('rearmAtEstimatedTokens');
    if (
      'checkpointReceipts' in fact &&
      (!Array.isArray(fact['checkpointReceipts']) ||
        !fact['checkpointReceipts'].every((value) => typeof value === 'string'))
    )
      check.fail('checkpointReceipts');
  },
  model_response_completed: (fact, check) => {
    check.text(fact['turnId'], 'turnId');
    if (!('modelStep' in fact)) check.fail('modelStep');
    if (!['end_turn', 'tool_use', 'max_tokens', 'refusal'].includes(fact['stopReason'] as string))
      check.fail('stopReason');
    if ('providerMetadata' in fact) check.object(fact['providerMetadata'], 'providerMetadata');
    if ('costUsd' in fact) validateProviderCost(fact['costUsd'], check.fail, 'costUsd');
  },
  request_cost_recorded: (fact, check, where) => {
    check.text(fact['turnId'], 'turnId');
    check.text(fact['rootTurnId'], 'rootTurnId');
    check.optionalText(fact, 'parentTurnId');
    validateRequestCost(fact['record'], where);
  },
  budget_opened: (fact, check, where) => {
    check.text(fact['turnId'], 'turnId');
    check.text(fact['requestId'], 'requestId');
    validateBudgetEvidence(fact['evidence'], where);
    const snapshot = check.object(fact['snapshot'], 'snapshot');
    for (const field of ['pricedUsdMicros', 'unpricedTokens', 'activeTimeMs', 'turns', 'extensionsGranted']) {
      const value = snapshot[field];
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) check.fail(`snapshot.${field}`);
    }
    if (
      !Array.isArray(snapshot['latchedStages']) ||
      !snapshot['latchedStages'].every((stage) => ['soft', 'warning', 'critical'].includes(stage))
    )
      check.fail('snapshot.latchedStages');
  },
  budget_closed: (fact, check, where) => {
    check.text(fact['turnId'], 'turnId');
    check.text(fact['requestId'], 'requestId');
    if (!['user', 'parent', 'system'].includes(fact['source'] as string)) check.fail('source');
    const decision = check.object(fact['decision'], 'decision');
    switch (decision['kind']) {
      case 'extend':
        if (decision['grantedBy'] !== 'human' && decision['grantedBy'] !== 'parent') check.fail('decision.grantedBy');
        break;
      case 'stop':
        break;
      case 'steer':
        validateHistory(decision['items'], where);
        break;
      default:
        check.fail('decision.kind');
    }
  },
  budget_observed: (fact, check, where) => {
    check.text(fact['turnId'], 'turnId');
    validateBudgetEvidence(fact['evidence'], where);
  },
  turn_ended: (fact, check) => {
    if ('finalWindow' in fact) check.fail('finalWindow');
    if (!['completed', 'cancelled', 'failed', 'interrupted'].includes(fact['outcome'] as string)) check.fail('outcome');
    if (
      'terminalCause' in fact &&
      !['goal_check_unresolved', 'completion_verification_blocked', 'budget_exhausted'].includes(
        fact['terminalCause'] as string,
      )
    )
      check.fail('terminalCause');
    if ('notice' in fact && typeof fact['notice'] !== 'string') check.fail('notice');
  },
  branch_started: (fact, check, where) => {
    check.optionalText(fact, 'parentTurnId');
    check.optionalText(fact, 'rootTurnId');
    check.text(fact['branchId'], 'branchId');
    check.text(fact['taskId'], 'taskId');
    check.text(fact['turnId'], 'turnId');
    validateHistory(fact['input'], where);
  },
  branch_event: (fact, check, where) => {
    check.text(fact['branchId'], 'branchId');
    const inner = check.object(fact['fact'], 'fact');
    if (
      ![
        'text_delta',
        'item',
        'tool_started',
        'tool_finished',
        'usage',
        'turn_ended',
        'history_replaced',
        'compaction_started',
        'compaction_completed',
        'compaction_failed',
        'model_response_completed',
        'budget_opened',
        'budget_closed',
        'budget_observed',
      ].includes(inner['type'] as string)
    )
      check.fail('fact.type');
    if (inner['type'] === 'history_replaced' && !inner['turnId']) check.fail('fact.turnId');
    validateFact(inner, `${where}.branch`);
  },
  task_started: (fact, check) => {
    const task = check.object(fact['task'], 'task');
    for (const field of ['taskId', 'sessionId', 'parentTurnId']) check.text(task[field], `task.${field}`);
    if (typeof task['label'] !== 'string' || !['shell', 'subagent'].includes(task['kind'] as string))
      check.fail('task');
    if (!['foreground', 'background'].includes(fact['mode'] as string)) check.fail('mode');
    if (typeof task['startedAt'] !== 'number' || !Number.isFinite(task['startedAt']) || task['startedAt'] < 0)
      check.fail('task.startedAt');
    for (const field of ['name', 'role', 'parentExecutionId', 'sourceCallId']) check.optionalText(task, field);
    if ('origin' in task && !validDirectQueueOrigin(task['origin'])) check.fail('task.origin');
    if ('model' in task) validateModelRef(task['model'], check.fail, 'task.model');
    if ('workspace' in task) {
      const workspace = check.object(task['workspace'], 'task.workspace');
      check.text(workspace['root'], 'workspace.root');
      check.text(workspace['target'], 'workspace.target');
      if (workspace['access'] !== 'read' && workspace['access'] !== 'read_write') check.fail('workspace.access');
    }
    // Absent input stays unknown. An empty string is not an original task.
    if ('input' in task && (typeof task['input'] !== 'string' || task['input'].length === 0)) check.fail('task.input');
  },
  task_backgrounded: validateTaskLifecycleSchema,
  task_stop_requested: validateTaskLifecycleSchema,
  task_finished: validateTaskLifecycleSchema,
  task_question_opened: (fact, check) => {
    if (typeof fact['at'] !== 'number' || !Number.isFinite(fact['at']) || fact['at'] < 0) check.fail('at');
    check.text(fact['taskId'], 'taskId');
    const question = check.object(fact['question'], 'question');
    check.text(question['messageId'], 'question.messageId');
    check.text(question['question'], 'question.question');
    if (typeof question['question'] !== 'string' || !question['question'].trim() || question['question'].length > 1200)
      check.fail('question.question');
  },
  task_question_closed: (fact, check) => {
    if (typeof fact['at'] !== 'number' || !Number.isFinite(fact['at']) || fact['at'] < 0) check.fail('at');
    check.text(fact['taskId'], 'taskId');
    check.text(fact['messageId'], 'messageId');
    const value = check.object(fact['resolution'], 'resolution');
    if (value['kind'] === 'answered') {
      check.text(value['answer'], 'resolution.answer');
      if (typeof value['answer'] !== 'string' || !value['answer'].trim() || value['answer'].length > 2000)
        check.fail('resolution.answer');
    } else if (value['kind'] !== 'cancelled' && value['kind'] !== 'interrupted') check.fail('resolution.kind');
  },
  task_interaction_opened: (fact, check, where) => {
    const request = check.object(fact['request'], 'request');
    check.text(request['taskId'], 'request.taskId');
    check.text(request['sessionId'], 'request.sessionId');
    if ('origin' in request && !validDirectQueueOrigin(request['origin'])) check.fail('request.origin');
    validateFact({ type: 'interaction_opened', turnId: request['turnId'], request }, where);
  },
  task_interaction_closed: (fact, check) => {
    check.text(fact['taskId'], 'taskId');
    check.text(fact['requestId'], 'requestId');
    const value = check.object(fact['resolution'], 'resolution');
    if (value['kind'] === 'decision') {
      const decision = check.object(value['decision'], 'resolution.decision');
      if (!['allow', 'deny', 'answer'].includes(decision['kind'] as string)) check.fail('resolution.decision.kind');
      check.resolution(decision);
    } else if (value['kind'] !== 'cancelled' && value['kind'] !== 'interrupted') check.fail('resolution.kind');
  },
  text_delta: () => {
    /* Envelope/modelStep validation only, unchanged. */
  },
  usage: () => {
    /* Envelope/modelStep validation only, unchanged. */
  },
};

/** Existing native model/error/cost rules, shared with compaction request evidence. */
function validateModelRef(value: unknown, fail: (field: string) => never, field: string): void {
  const model = objectRecord(value, fail, field);
  for (const key of ['provider', 'model'])
    if (typeof model[key] !== 'string' || model[key] === '') fail(`${field}.${key}`);
}

function validateModelError(value: unknown, fail: (field: string) => never, field: string): void {
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

function validateProviderCost(value: unknown, fail: (field: string) => never, field: string): void {
  if (
    (typeof value !== 'number' && typeof value !== 'string') ||
    (typeof value === 'string' && !value.trim()) ||
    !Number.isFinite(Number(value)) ||
    Number(value) < 0
  )
    fail(field);
}

/** Validate lifecycle evidence in place: never default or normalize missing metrics. */
function validateCompactionFact(fact: Record<string, unknown>, fail: (field: string) => never): void {
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
