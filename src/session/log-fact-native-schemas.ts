/** Native fact-family schemas; shared validation primitives remain in log-facts.ts. */
import type { FactSchema, FactValidation } from './log-facts.js';
import { validDirectQueueOrigin, directContentSchema } from './queue-decode.js';
import {
  validateBudgetEvidence,
  validateCompactionFact,
  validateFact,
  validateHistory,
  validateModelError,
  validateModelRef,
  validateProviderCost,
  validateRequestConfiguration,
  validateRequestCost,
} from './log-facts.js';

const directSessionId = /^conv_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const validateCompactionSchema: FactSchema = (fact, check) => {
  validateCompactionFact(fact, check.fail);
};

const validateTaskLifecycleSchema: FactSchema = (fact, check: FactValidation) => {
  check.text(fact['taskId'], 'taskId');
  if (typeof fact['at'] !== 'number' || !Number.isFinite(fact['at']) || fact['at'] < 0) check.fail('at');
  if (
    fact['type'] === 'task_stop_requested' &&
    fact['by'] !== undefined &&
    fact['by'] !== 'model' &&
    fact['by'] !== 'user'
  )
    check.fail('by');
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
export const nativeSchemas: Record<string, FactSchema> = {
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
    if ('requestNotice' in fact) check.text(fact['requestNotice'], 'requestNotice');
    if ('persistentNotice' in fact) check.text(fact['persistentNotice'], 'persistentNotice');
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
    if ('grants' in request) {
      const grants = request['grants'];
      if (!Array.isArray(grants) || grants.some((grant) => typeof grant !== 'string')) check.fail('request.grants');
    }
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
      'rearmAtRenderedTokens' in fact &&
      (typeof fact['rearmAtRenderedTokens'] !== 'number' ||
        !Number.isFinite(fact['rearmAtRenderedTokens']) ||
        fact['rearmAtRenderedTokens'] < 0)
    )
      check.fail('rearmAtRenderedTokens');
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
    if ('resolutionSource' in fact && !['user', 'policy', 'system'].includes(fact['resolutionSource'] as string))
      check.fail('resolutionSource');
    if ('automaticApproval' in fact && typeof fact['automaticApproval'] !== 'boolean') check.fail('automaticApproval');
    check.text(fact['taskId'], 'taskId');
    check.text(fact['requestId'], 'requestId');
    const value = check.object(fact['resolution'], 'resolution');
    if (value['kind'] === 'decision') {
      const decision = check.object(value['decision'], 'resolution.decision');
      if (!['allow', 'deny', 'answer'].includes(decision['kind'] as string)) check.fail('resolution.decision.kind');
      check.resolution(decision);
    } else if (value['kind'] !== 'cancelled' && value['kind'] !== 'interrupted') check.fail('resolution.kind');
  },
  text_delta: (fact, check) => {
    if ('withdrawn' in fact && fact['withdrawn'] !== true) check.fail('withdrawn');
  },
  usage: () => {
    /* Envelope/modelStep validation only, unchanged. */
  },
};

/** Existing native model/error/cost rules, shared with compaction request evidence. */
