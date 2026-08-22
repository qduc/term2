import {
  ASK_USER_DECLINE_RESULT,
  ASK_USER_NO_ANSWER_RESULT,
  isAskUserTerminalAnswer,
} from '../tools/agent/ask-user-constants.js';
import { supportsFolderSessionRead } from '../contracts/conversation.js';

export type InteractionKind = 'tool_approval' | 'ask_user' | 'check_in';
export type InteractionVariant =
  | 'ordinary_tool'
  | 'folder_read'
  | 'outside_workspace_edit'
  | 'denied_read'
  | 'docker_host_control'
  | 'sandbox_network_access'
  | 'post_execute'
  | 'max_turns'
  | 'run_budget'
  | 'ask_user';

export type SafeChoice = {
  id: string;
  label: string;
  description?: string;
  destructive?: boolean;
};

export type AskUserQuestionDto = {
  index: number;
  question: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect: boolean;
};

export type PendingInteractionDto = {
  version: 1;
  interactionId: string;
  kind: InteractionKind;
  variant: InteractionVariant;
  descriptor: {
    agentName: string;
    toolName: string;
    callId?: string;
    argumentsText: string;
    display?: { command?: string; target?: string; scope?: string; warning?: string };
    llmAdvisory?: { reasoning: string; approved: boolean; model: string; riskLevel?: string };
    checkIn?: 'max_turns' | 'run_budget';
    deniedRead?: { displayPath: string; displayParent: string; sensitive: boolean };
    runBudgetEvidence?: Record<string, number>;
  };
  choices: SafeChoice[];
  askUser?: {
    questions: AskUserQuestionDto[];
    answers: Array<string | string[]>;
    currentQuestionIndex: number;
  };
  revision: number;
};

export class InteractionProtocolError extends Error {
  readonly code = 'interaction_sanitization_rejected' as const;
  constructor(message = 'interaction descriptor is not safe for presentation') {
    super(message);
    this.name = 'InteractionProtocolError';
  }
}

const MAX_TEXT = 8_192;
const MAX_QUESTIONS = 32;
const MAX_OPTIONS = 32;
const OPAQUE_ID = /^[A-Za-z0-9_-]{1,256}$/;

function text(value: unknown, max = MAX_TEXT, required = false): string {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    if (required) throw new InteractionProtocolError();
    return '';
  }
  return value;
}

function redact(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer <redacted>')
    .replace(/(api[_-]?key|token|password|secret)\s*[:=]\s*[^\s,;]+/gi, '$1=<redacted>')
    .replace(/(?:[A-Za-z]:[\\/]|\/)(?:[A-Za-z0-9._~@-]+[\\/])+[A-Za-z0-9._~@-]+/g, '<path>')
    .slice(0, MAX_TEXT);
}

function choice(id: string, label: string, extra: Partial<SafeChoice> = {}): SafeChoice {
  return { id, label, ...extra };
}

function parseAskUserQuestions(argumentsText: string): AskUserQuestionDto[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsText);
  } catch {
    throw new InteractionProtocolError('ask_user arguments are not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { questions?: unknown }).questions))
    throw new InteractionProtocolError('ask_user questions are malformed');
  const questions = (parsed as { questions: unknown[] }).questions;
  if (questions.length === 0 || questions.length > MAX_QUESTIONS) throw new InteractionProtocolError();
  return questions.map((raw, index) => {
    if (!raw || typeof raw !== 'object') throw new InteractionProtocolError();
    const value = raw as Record<string, unknown>;
    const question = redact(text(value.question, 4_096, true));
    if (!Array.isArray(value.options) || value.options.length > MAX_OPTIONS) throw new InteractionProtocolError();
    const options = value.options.map((rawOption) => {
      if (!rawOption || typeof rawOption !== 'object') throw new InteractionProtocolError();
      const option = rawOption as Record<string, unknown>;
      const label = redact(text(option.label ?? option.value, 512, true));
      const description = option.description === undefined ? undefined : redact(text(option.description, 2_048, true));
      return { label, ...(description ? { description } : {}) };
    });
    return { index, question, options, multiSelect: value.is_multi_select === true };
  });
}

function runBudgetEvidence(approval: Record<string, unknown>): Record<string, number> | undefined {
  const event = approval.runBudgetEvent;
  if (!event || typeof event !== 'object') return undefined;
  const evidence = (event as Record<string, unknown>).evidence;
  if (evidence && typeof evidence === 'object') {
    const result: Record<string, number> = {};
    for (const key of ['used', 'limit', 'headroom']) {
      const value = (evidence as Record<string, unknown>)[key];
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new InteractionProtocolError();
      result[key] = value;
    }
    if (Object.keys(result).length) return result;
  }
  const result: Record<string, number> = {};
  for (const key of ['count', 'threshold']) {
    const value = (event as Record<string, unknown>)[key];
    if (value !== undefined) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new InteractionProtocolError();
      result[key] = value;
    }
  }
  return Object.keys(result).length ? result : undefined;
}

export function projectPendingInteraction(
  approval: Record<string, unknown>,
  interactionId: string,
  revision: number,
  answers: readonly unknown[] = [],
  currentQuestionIndex = 0,
): PendingInteractionDto {
  if (!OPAQUE_ID.test(interactionId) || !Number.isSafeInteger(revision) || revision < 1) {
    throw new InteractionProtocolError();
  }
  const agentName = text(approval.agentName, 256, true);
  const toolName = text(approval.toolName, 256, true);
  const argumentsText = text(approval.argumentsText, MAX_TEXT, true);
  const isAskUser = toolName === 'ask_user';
  const checkIn = approval.checkIn === 'max_turns' || approval.checkIn === 'run_budget' ? approval.checkIn : undefined;
  const deniedRead = approval.deniedRead;
  const isDeniedRead = deniedRead && typeof deniedRead === 'object';
  const outsideEdit = approval.outsideWorkspaceEdit && typeof approval.outsideWorkspaceEdit === 'object';
  const isDocker = approval.dockerHostControl === true;
  const isNetwork = approval.sandboxNetworkAccess === true || approval.networkAccess === true;
  const isPostExecute = approval.postExecute && typeof approval.postExecute === 'object';
  const variant: InteractionVariant = checkIn
    ? checkIn
    : isAskUser
    ? 'ask_user'
    : isDocker
    ? 'docker_host_control'
    : isNetwork
    ? 'sandbox_network_access'
    : isDeniedRead
    ? 'denied_read'
    : outsideEdit
    ? 'outside_workspace_edit'
    : isPostExecute
    ? 'post_execute'
    : supportsFolderSessionRead(toolName)
    ? 'folder_read'
    : 'ordinary_tool';

  const descriptor: PendingInteractionDto['descriptor'] = { agentName, toolName, argumentsText: redact(argumentsText) };
  if (typeof approval.callId === 'string' && OPAQUE_ID.test(approval.callId)) descriptor.callId = approval.callId;
  if (checkIn) descriptor.checkIn = checkIn;
  if (isDeniedRead) {
    const value = deniedRead as Record<string, unknown>;
    const sensitive = value.sensitive === true;
    descriptor.deniedRead = {
      displayPath: '<outside-workspace>',
      displayParent: '<outside-workspace>',
      sensitive,
    };
    descriptor.display = { target: '<outside-workspace>', warning: 'The sandbox denied this read.' };
  } else if (outsideEdit) {
    descriptor.display = { target: '<outside-workspace>', scope: '<outside-workspace>' };
  }
  if (approval.llmAdvisory && typeof approval.llmAdvisory === 'object') {
    const advisory = approval.llmAdvisory as Record<string, unknown>;
    const reasoning = text(advisory.reasoning, 2_048, true);
    const model = text(advisory.model, 256, true);
    if (typeof advisory.approved !== 'boolean') throw new InteractionProtocolError();
    descriptor.llmAdvisory = {
      reasoning: redact(reasoning),
      approved: advisory.approved,
      model,
      ...(typeof advisory.riskLevel === 'string' ? { riskLevel: text(advisory.riskLevel, 32, true) } : {}),
    };
  }
  const evidence = runBudgetEvidence(approval);
  if (evidence) descriptor.runBudgetEvidence = evidence;

  const questions = isAskUser ? parseAskUserQuestions(argumentsText) : undefined;
  if (
    questions &&
    (!Number.isSafeInteger(currentQuestionIndex) ||
      currentQuestionIndex < 0 ||
      currentQuestionIndex >= questions.length)
  )
    throw new InteractionProtocolError();
  const normalizedAnswers = answers.map((answer) => {
    if (typeof answer === 'string') return text(answer, 16_384, true);
    if (Array.isArray(answer) && answer.length <= MAX_OPTIONS && answer.every((item) => typeof item === 'string'))
      return answer.map((item) => text(item, 512, true));
    throw new InteractionProtocolError();
  });

  let choices: SafeChoice[];
  switch (variant) {
    case 'max_turns':
    case 'run_budget':
      choices = [choice('continue', 'Continue'), choice('stop', 'Stop')];
      break;
    case 'folder_read':
      choices = [
        choice('allow-once', 'Allow once'),
        choice('allow-folder-session', 'Allow folder for session'),
        choice('reject', 'Reject'),
      ];
      break;
    case 'outside_workspace_edit':
      choices = [
        choice('allow-once', 'Allow once'),
        choice('allow-edit-file-session', 'Allow file for session'),
        choice('allow-edit-folder-session', 'Allow folder for session'),
        choice('reject', 'Reject'),
      ];
      break;
    case 'denied_read': {
      const sensitive = descriptor.deniedRead?.sensitive === true;
      choices = [
        choice('allow-once', 'Allow once'),
        ...(sensitive ? [] : [choice('allow-remember', 'Allow and remember')]),
        choice('unsandboxed-once', 'Run unsandboxed once'),
        choice('deny', 'Deny'),
      ];
      break;
    }
    case 'docker_host_control':
      choices = [
        choice('docker-allow-once', 'Allow once'),
        choice('docker-allow-session', 'Allow for session'),
        choice('docker-allow-project', 'Allow for project'),
        choice('deny', 'Deny'),
      ];
      break;
    case 'sandbox_network_access':
      choices = [
        choice('allow-once', 'Allow once'),
        choice('deny', 'Deny'),
        choice('allow-session', 'Allow for session'),
        choice('allow-project', 'Allow for project'),
      ];
      break;
    case 'post_execute':
      choices = [choice('approve', 'Approve'), choice('reject', 'Reject')];
      break;
    case 'ask_user': {
      const current = questions![currentQuestionIndex]!;
      choices = [
        ...current.options.map((option, index) => choice(`option:${index}`, option.label)),
        choice('custom', 'Custom answer'),
        choice('decline', 'Decline'),
        choice('cancel', 'Cancel'),
      ];
      break;
    }
    default:
      choices = [choice('approve', 'Allow'), choice('reject', 'Reject')];
  }
  return {
    version: 1,
    interactionId,
    kind: variant === 'ask_user' ? 'ask_user' : checkIn ? 'check_in' : 'tool_approval',
    variant,
    descriptor,
    choices,
    ...(questions
      ? {
          askUser: {
            questions,
            answers: normalizedAnswers,
            currentQuestionIndex,
          },
        }
      : {}),
    revision,
  };
}

const DTO_KEYS = new Set([
  'version',
  'interactionId',
  'kind',
  'variant',
  'descriptor',
  'choices',
  'askUser',
  'revision',
]);
const DESCRIPTOR_KEYS = new Set([
  'agentName',
  'toolName',
  'callId',
  'argumentsText',
  'display',
  'llmAdvisory',
  'checkIn',
  'deniedRead',
  'runBudgetEvidence',
]);

function exactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

/** Validate persisted/replayed DTOs without reconstructing private approval state. */
export function validatePendingInteractionDto(value: unknown): PendingInteractionDto {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InteractionProtocolError();
  const dto = value as Record<string, unknown>;
  if (
    !exactKeys(dto, DTO_KEYS) ||
    dto.version !== 1 ||
    typeof dto.interactionId !== 'string' ||
    !OPAQUE_ID.test(dto.interactionId)
  )
    throw new InteractionProtocolError();
  if (!['tool_approval', 'ask_user', 'check_in'].includes(String(dto.kind))) throw new InteractionProtocolError();
  const variants: InteractionVariant[] = [
    'ordinary_tool',
    'folder_read',
    'outside_workspace_edit',
    'denied_read',
    'docker_host_control',
    'sandbox_network_access',
    'post_execute',
    'max_turns',
    'run_budget',
    'ask_user',
  ];
  if (typeof dto.variant !== 'string' || !variants.includes(dto.variant as InteractionVariant))
    throw new InteractionProtocolError();
  if (
    (dto.kind === 'ask_user' && dto.variant !== 'ask_user') ||
    (dto.kind === 'check_in' && dto.variant !== 'max_turns' && dto.variant !== 'run_budget') ||
    (dto.kind === 'tool_approval' &&
      (dto.variant === 'ask_user' || dto.variant === 'max_turns' || dto.variant === 'run_budget'))
  )
    throw new InteractionProtocolError();
  if (typeof dto.revision !== 'number' || !Number.isSafeInteger(dto.revision) || dto.revision < 1)
    throw new InteractionProtocolError();
  const descriptor = dto.descriptor;
  if (
    !descriptor ||
    typeof descriptor !== 'object' ||
    Array.isArray(descriptor) ||
    !exactKeys(descriptor as Record<string, unknown>, DESCRIPTOR_KEYS)
  )
    throw new InteractionProtocolError();
  const descriptorValue = descriptor as Record<string, unknown>;
  text(descriptorValue.agentName, 256, true);
  text(descriptorValue.toolName, 256, true);
  text(descriptorValue.argumentsText, MAX_TEXT, true);
  if (
    descriptorValue.callId !== undefined &&
    (typeof descriptorValue.callId !== 'string' || !OPAQUE_ID.test(descriptorValue.callId))
  )
    throw new InteractionProtocolError();
  if (descriptorValue.display !== undefined) {
    if (
      !descriptorValue.display ||
      typeof descriptorValue.display !== 'object' ||
      !exactKeys(descriptorValue.display as Record<string, unknown>, new Set(['command', 'target', 'scope', 'warning']))
    )
      throw new InteractionProtocolError();
    for (const child of Object.values(descriptorValue.display as Record<string, unknown>)) text(child, 2_048, true);
  }
  if (descriptorValue.llmAdvisory !== undefined) {
    if (
      !descriptorValue.llmAdvisory ||
      typeof descriptorValue.llmAdvisory !== 'object' ||
      !exactKeys(
        descriptorValue.llmAdvisory as Record<string, unknown>,
        new Set(['reasoning', 'approved', 'model', 'riskLevel']),
      )
    )
      throw new InteractionProtocolError();
    const advisory = descriptorValue.llmAdvisory as Record<string, unknown>;
    text(advisory.reasoning, 2_048, true);
    text(advisory.model, 256, true);
    if (
      typeof advisory.approved !== 'boolean' ||
      (advisory.riskLevel !== undefined && typeof advisory.riskLevel !== 'string')
    )
      throw new InteractionProtocolError();
  }
  if (descriptorValue.deniedRead !== undefined) {
    if (
      !descriptorValue.deniedRead ||
      typeof descriptorValue.deniedRead !== 'object' ||
      !exactKeys(
        descriptorValue.deniedRead as Record<string, unknown>,
        new Set(['displayPath', 'displayParent', 'sensitive']),
      )
    )
      throw new InteractionProtocolError();
    const denied = descriptorValue.deniedRead as Record<string, unknown>;
    text(denied.displayPath, 256, true);
    text(denied.displayParent, 256, true);
    if (typeof denied.sensitive !== 'boolean') throw new InteractionProtocolError();
  }
  if (descriptorValue.runBudgetEvidence !== undefined) {
    if (!descriptorValue.runBudgetEvidence || typeof descriptorValue.runBudgetEvidence !== 'object')
      throw new InteractionProtocolError();
    for (const value of Object.values(descriptorValue.runBudgetEvidence as Record<string, unknown>))
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new InteractionProtocolError();
  }
  if (!Array.isArray(dto.choices) || dto.choices.length === 0 || dto.choices.length > MAX_OPTIONS)
    throw new InteractionProtocolError();
  for (const rawChoice of dto.choices) {
    if (!rawChoice || typeof rawChoice !== 'object' || Array.isArray(rawChoice)) throw new InteractionProtocolError();
    const safeChoice = rawChoice as Record<string, unknown>;
    if (
      !exactKeys(safeChoice, new Set(['id', 'label', 'description', 'destructive'])) ||
      typeof safeChoice.id !== 'string' ||
      !/^[A-Za-z0-9:_-]{1,128}$/.test(safeChoice.id) ||
      typeof safeChoice.label !== 'string'
    )
      throw new InteractionProtocolError();
    if (safeChoice.description !== undefined) text(safeChoice.description, 2_048, true);
    if (safeChoice.destructive !== undefined && typeof safeChoice.destructive !== 'boolean')
      throw new InteractionProtocolError();
  }
  if (dto.askUser !== undefined) {
    if (dto.kind !== 'ask_user' || !dto.askUser || typeof dto.askUser !== 'object')
      throw new InteractionProtocolError();
    const ask = dto.askUser as Record<string, unknown>;
    if (
      !exactKeys(ask, new Set(['questions', 'answers', 'currentQuestionIndex'])) ||
      !Array.isArray(ask.questions) ||
      !Array.isArray(ask.answers)
    )
      throw new InteractionProtocolError();
    if (ask.questions.length === 0 || ask.questions.length > MAX_QUESTIONS) throw new InteractionProtocolError();
    ask.questions.forEach((rawQuestion, index) => {
      if (
        !rawQuestion ||
        typeof rawQuestion !== 'object' ||
        !exactKeys(rawQuestion as Record<string, unknown>, new Set(['index', 'question', 'options', 'multiSelect']))
      )
        throw new InteractionProtocolError();
      const question = rawQuestion as Record<string, unknown>;
      if (
        question.index !== index ||
        typeof question.question !== 'string' ||
        !Array.isArray(question.options) ||
        typeof question.multiSelect !== 'boolean'
      )
        throw new InteractionProtocolError();
      text(question.question, 4_096, true);
      if (question.options.length > MAX_OPTIONS) throw new InteractionProtocolError();
      question.options.forEach((rawOption) => {
        if (
          !rawOption ||
          typeof rawOption !== 'object' ||
          !exactKeys(rawOption as Record<string, unknown>, new Set(['label', 'description']))
        )
          throw new InteractionProtocolError();
        const option = rawOption as Record<string, unknown>;
        text(option.label, 512, true);
        if (option.description !== undefined) text(option.description, 2_048, true);
      });
    });
    ask.answers.forEach((answer) => {
      if (typeof answer === 'string') text(answer, 16_384, true);
      else if (Array.isArray(answer)) answer.forEach((item) => text(item, 512, true));
      else throw new InteractionProtocolError();
    });
    const currentQuestionIndex = ask.currentQuestionIndex;
    if (
      typeof currentQuestionIndex !== 'number' ||
      !Number.isSafeInteger(currentQuestionIndex) ||
      currentQuestionIndex < 0 ||
      currentQuestionIndex >= ask.questions.length
    )
      throw new InteractionProtocolError();
  }
  return dto as PendingInteractionDto;
}

export type InteractionDecision = {
  answer: string;
  approvalAnswer?: string;
  rejectionReason?: string;
  outcome: 'approved' | 'rejected' | 'cancelled' | 'continued';
};

export function decideInteraction(
  dto: PendingInteractionDto,
  body: { answer: string; rejectionReason?: string; approvalAnswer?: string },
): InteractionDecision {
  if (!dto.choices.some((item) => item.id === body.answer))
    throw new InteractionProtocolError('choice is not advertised');
  if (body.rejectionReason !== undefined) {
    if (body.rejectionReason.length > 2_048 || /[\u0000-\u001f\u007f]/.test(body.rejectionReason))
      throw new InteractionProtocolError('rejection reason is invalid');
    if (dto.kind === 'ask_user' || dto.kind === 'check_in')
      throw new InteractionProtocolError('reason is not applicable');
  }
  const reject = new Set(['reject', 'deny', 'stop']);
  if (dto.kind === 'check_in') {
    return body.answer === 'continue' ? { answer: 'y', outcome: 'continued' } : { answer: 'n', outcome: 'rejected' };
  }
  if (dto.kind === 'ask_user') {
    if (body.answer === 'decline') return { answer: 'y', approvalAnswer: ASK_USER_DECLINE_RESULT, outcome: 'rejected' };
    if (body.answer === 'cancel')
      return { answer: 'y', approvalAnswer: ASK_USER_NO_ANSWER_RESULT, outcome: 'cancelled' };
    if (body.answer.startsWith('option:')) {
      const index = Number(body.answer.slice('option:'.length));
      const option = dto.askUser?.questions[dto.askUser.currentQuestionIndex]?.options[index];
      if (!option) throw new InteractionProtocolError('choice is not valid for the current question');
      const current = dto.askUser?.questions[dto.askUser.currentQuestionIndex];
      return {
        answer: 'y',
        approvalAnswer: current?.multiSelect ? JSON.stringify([option.label]) : option.label,
        outcome: 'approved',
      };
    }
    if (body.answer === 'custom') {
      if (
        typeof body.approvalAnswer !== 'string' ||
        body.approvalAnswer.length === 0 ||
        body.approvalAnswer.length > 16_384
      )
        throw new InteractionProtocolError('custom answer is invalid');
      if (isAskUserTerminalAnswer(body.approvalAnswer))
        throw new InteractionProtocolError('terminal answer is reserved');
      const current = dto.askUser?.questions[dto.askUser.currentQuestionIndex];
      if (current?.multiSelect) {
        let values: unknown;
        try {
          values = JSON.parse(body.approvalAnswer);
        } catch {
          throw new InteractionProtocolError('multi-select answer is invalid');
        }
        if (
          !Array.isArray(values) ||
          values.length > MAX_OPTIONS ||
          values.some((item) => !current.options.some((option) => option.label === item))
        )
          throw new InteractionProtocolError('multi-select answer is invalid');
      }
      return { answer: 'y', approvalAnswer: body.approvalAnswer, outcome: 'approved' };
    }
    throw new InteractionProtocolError('ask_user choice is invalid');
  }
  if (reject.has(body.answer)) return { answer: 'n', rejectionReason: body.rejectionReason, outcome: 'rejected' };
  if (body.answer === 'approve') return { answer: 'y', outcome: 'approved' };
  return { answer: body.answer, outcome: 'approved' };
}

/** Re-sanitize DTOs loaded from a local checkpoint before they re-enter a public projection. */
export function sanitizePendingInteractionDto(value: unknown): PendingInteractionDto {
  const dto = validatePendingInteractionDto(value);
  const descriptor = {
    ...dto.descriptor,
    argumentsText: redact(dto.descriptor.argumentsText),
    ...(dto.descriptor.display
      ? {
          display: Object.fromEntries(
            Object.entries(dto.descriptor.display).map(([key, child]) => [key, redact(child ?? '')]),
          ),
        }
      : {}),
    ...(dto.descriptor.llmAdvisory
      ? {
          llmAdvisory: {
            ...dto.descriptor.llmAdvisory,
            reasoning: redact(dto.descriptor.llmAdvisory.reasoning),
            model: redact(dto.descriptor.llmAdvisory.model),
            ...(dto.descriptor.llmAdvisory.riskLevel
              ? { riskLevel: redact(dto.descriptor.llmAdvisory.riskLevel) }
              : {}),
          },
        }
      : {}),
    ...(dto.descriptor.deniedRead
      ? {
          deniedRead: {
            ...dto.descriptor.deniedRead,
            displayPath: redact(dto.descriptor.deniedRead.displayPath),
            displayParent: redact(dto.descriptor.deniedRead.displayParent),
          },
        }
      : {}),
  };
  const sanitized: PendingInteractionDto = {
    ...dto,
    descriptor,
    choices: dto.choices.map((item) => ({
      ...item,
      label: redact(item.label),
      ...(item.description ? { description: redact(item.description) } : {}),
    })),
    ...(dto.askUser
      ? {
          askUser: {
            ...dto.askUser,
            questions: dto.askUser.questions.map((question) => ({
              ...question,
              question: redact(question.question),
              options: question.options.map((option) => ({
                label: redact(option.label),
                ...(option.description ? { description: redact(option.description) } : {}),
              })),
            })),
            answers: dto.askUser.answers.map((answer) =>
              Array.isArray(answer) ? answer.map((item) => redact(item)) : redact(answer),
            ),
          },
        }
      : {}),
  };
  return validatePendingInteractionDto(sanitized);
}
