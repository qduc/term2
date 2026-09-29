export const AGENT_EVENT_TYPES = [
  'session_created',
  'user_message_accepted',
  'user_message_rejected',
  'assistant_started',
  'text_delta',
  'reasoning_delta',
  'tool_started',
  'command_message',
  'approval_required',
  'interaction_updated',
  'interaction_resolved',
  'interaction_recovered',
  'usage_update',
  'retry',
  'retry_exhausted',
  'subagent_started',
  'subagent_tool_started',
  'subagent_text_turn',
  'subagent_command_message',
  'subagent_approval_required',
  'subagent_completed',
  'subagent_interrupted',
  'subagent_question',
  'context_compaction_started',
  'context_compaction_completed',
  'context_compaction_failed',
  'turn_completed',
  'turn_failed',
  'turn_aborted',
] as const;
export type AgentEventType = (typeof AGENT_EVENT_TYPES)[number];
export const FROZEN_AGENT_EVENT_TYPES = AGENT_EVENT_TYPES;
export type AgentEventEnvelope = {
  readonly schemaVersion: 1;
  readonly id: number;
  readonly sessionId: string;
  readonly type: AgentEventType;
  readonly occurredAt: string;
  readonly payload: Readonly<Record<string, unknown>>;
};
export class AgentWireError extends Error {
  constructor(message = 'invalid agent wire value') {
    super(message);
    this.name = 'AgentWireError';
  }
}
const EVENT_SET = new Set<string>(AGENT_EVENT_TYPES);
const ID = /^[A-Za-z0-9_-]{1,256}$/;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AgentWireError();
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/.test(value))
    throw new AgentWireError();
  return value;
}
function keys(value: Record<string, unknown>, allowed: readonly string[], required = allowed): void {
  const present = new Set(Object.keys(value));
  if (Object.keys(value).some((key) => !allowed.includes(key)) || required.some((key) => !present.has(key)))
    throw new AgentWireError();
}
export function parseAgentEventEnvelope(value: unknown, expectedSessionId?: string): AgentEventEnvelope {
  const input = object(value);
  keys(input, ['schemaVersion', 'id', 'sessionId', 'type', 'occurredAt', 'payload']);
  if (
    input.schemaVersion !== 1 ||
    typeof input.id !== 'number' ||
    !Number.isSafeInteger(input.id) ||
    input.id < 1 ||
    typeof input.type !== 'string' ||
    !EVENT_SET.has(input.type)
  )
    throw new AgentWireError('unsupported agent event');
  const sessionId = text(input.sessionId, 256);
  if (!ID.test(sessionId) || (expectedSessionId && sessionId !== expectedSessionId))
    throw new AgentWireError('event identity mismatch');
  return {
    schemaVersion: 1,
    id: input.id,
    sessionId,
    type: input.type as AgentEventType,
    occurredAt: text(input.occurredAt, 128),
    payload: object(input.payload),
  };
}
export const parseEventEnvelope = parseAgentEventEnvelope;
export const InteractionProtocolError = AgentWireError;
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
export type SafeChoice = { id: string; label: string; description?: string; destructive?: boolean };
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
  askUser?: { questions: AskUserQuestionDto[]; answers: Array<string | string[]>; currentQuestionIndex: number };
  revision: number;
};
const VARIANTS: readonly InteractionVariant[] = [
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
export function validatePendingInteractionDto(value: unknown): PendingInteractionDto {
  const dto = object(value);
  keys(
    dto,
    ['version', 'interactionId', 'kind', 'variant', 'descriptor', 'choices', 'askUser', 'revision'],
    ['version', 'interactionId', 'kind', 'variant', 'descriptor', 'choices', 'revision'],
  );
  if (
    dto.version !== 1 ||
    typeof dto.interactionId !== 'string' ||
    !ID.test(dto.interactionId) ||
    typeof dto.kind !== 'string' ||
    !['tool_approval', 'ask_user', 'check_in'].includes(dto.kind) ||
    typeof dto.variant !== 'string' ||
    !VARIANTS.includes(dto.variant as InteractionVariant) ||
    typeof dto.revision !== 'number' ||
    !Number.isSafeInteger(dto.revision) ||
    dto.revision < 1
  )
    throw new AgentWireError();
  if (
    (dto.kind === 'ask_user' && dto.variant !== 'ask_user') ||
    (dto.kind === 'check_in' && !['max_turns', 'run_budget'].includes(dto.variant)) ||
    (dto.kind === 'tool_approval' && ['ask_user', 'max_turns', 'run_budget'].includes(dto.variant))
  )
    throw new AgentWireError();
  const descriptor = object(dto.descriptor);
  keys(
    descriptor,
    [
      'agentName',
      'toolName',
      'callId',
      'argumentsText',
      'display',
      'llmAdvisory',
      'checkIn',
      'deniedRead',
      'runBudgetEvidence',
    ],
    ['agentName', 'toolName', 'argumentsText'],
  );
  text(descriptor.agentName, 256);
  text(descriptor.toolName, 256);
  text(descriptor.argumentsText, 8192);
  if (descriptor.callId !== undefined && (typeof descriptor.callId !== 'string' || !ID.test(descriptor.callId)))
    throw new AgentWireError();
  if (descriptor.display !== undefined) {
    const display = object(descriptor.display);
    keys(display, ['command', 'target', 'scope', 'warning'], []);
    for (const v of Object.values(display)) text(v, 2048);
  }
  if (descriptor.llmAdvisory !== undefined) {
    const a = object(descriptor.llmAdvisory);
    keys(a, ['reasoning', 'approved', 'model', 'riskLevel'], ['reasoning', 'approved', 'model']);
    text(a.reasoning, 2048);
    text(a.model, 256);
    if (typeof a.approved !== 'boolean' || (a.riskLevel !== undefined && typeof a.riskLevel !== 'string'))
      throw new AgentWireError();
  }
  if (descriptor.deniedRead !== undefined) {
    const d = object(descriptor.deniedRead);
    keys(d, ['displayPath', 'displayParent', 'sensitive']);
    text(d.displayPath, 256);
    text(d.displayParent, 256);
    if (typeof d.sensitive !== 'boolean') throw new AgentWireError();
  }
  if (descriptor.runBudgetEvidence !== undefined) {
    const e = object(descriptor.runBudgetEvidence);
    for (const v of Object.values(e))
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new AgentWireError();
  }
  if (!Array.isArray(dto.choices) || dto.choices.length === 0 || dto.choices.length > 32) throw new AgentWireError();
  for (const raw of dto.choices) {
    const c = object(raw);
    keys(c, ['id', 'label', 'description', 'destructive'], ['id', 'label']);
    if (typeof c.id !== 'string' || !/^[A-Za-z0-9:_-]{1,128}$/.test(c.id)) throw new AgentWireError();
    text(c.label, 2048);
    if (c.description !== undefined) text(c.description, 2048);
    if (c.destructive !== undefined && typeof c.destructive !== 'boolean') throw new AgentWireError();
  }
  if (dto.askUser !== undefined) {
    if (dto.kind !== 'ask_user') throw new AgentWireError();
    const ask = object(dto.askUser);
    keys(ask, ['questions', 'answers', 'currentQuestionIndex']);
    if (
      !Array.isArray(ask.questions) ||
      !Array.isArray(ask.answers) ||
      ask.questions.length === 0 ||
      ask.questions.length > 32
    )
      throw new AgentWireError();
    ask.questions.forEach((raw, index) => {
      const q = object(raw);
      keys(q, ['index', 'question', 'options', 'multiSelect']);
      if (
        q.index !== index ||
        typeof q.question !== 'string' ||
        !Array.isArray(q.options) ||
        typeof q.multiSelect !== 'boolean'
      )
        throw new AgentWireError();
      text(q.question, 4096);
      if (q.options.length > 32) throw new AgentWireError();
      q.options.forEach((rawOption) => {
        const option = object(rawOption);
        keys(option, ['label', 'description'], ['label']);
        text(option.label, 512);
        if (option.description !== undefined) text(option.description, 2048);
      });
    });
    ask.answers.forEach((answer) => {
      if (typeof answer === 'string') text(answer, 16384);
      else if (Array.isArray(answer)) answer.forEach((item) => text(item, 512));
      else throw new AgentWireError();
    });
    if (
      typeof ask.currentQuestionIndex !== 'number' ||
      !Number.isSafeInteger(ask.currentQuestionIndex) ||
      ask.currentQuestionIndex < 0 ||
      ask.currentQuestionIndex >= ask.questions.length
    )
      throw new AgentWireError();
  }
  return dto as PendingInteractionDto;
}
