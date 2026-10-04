export const TERM2_CONTRACT_VERSION = 1 as const;
/**
 * Digest of the immutable v1 (P105) identity choices. The M4 event additions
 * are additive beyond that fixture and are not covered by this digest.
 */
export const TERM2_FREEZE_SHA = '11b1f3637e6110e73b63d8a199b0e9a9d4001b78c49eec0fbe2a9725e01d2fdc';

import { AGENT_EVENT_TYPES } from '@qduc/agent-wire';

export const TERM2_EVENT_TYPES = AGENT_EVENT_TYPES;
export type Term2EventType = (typeof TERM2_EVENT_TYPES)[number];
export const TERM2_EVENT_TYPE_SET = new Set<string>(TERM2_EVENT_TYPES);

export type InteractionKind = 'tool_approval' | 'ask_user' | 'check_in';
export type InteractionOutcome = 'approved' | 'rejected' | 'cancelled' | 'continued';
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

export interface WorkspaceAlias {
  workspaceId: string;
  label: string;
  access: 'read' | 'read_write';
}

export type SessionStatus = 'idle' | 'running' | 'awaiting_interaction' | 'interrupted' | 'closed';
export interface SessionListItem {
  id: string;
  workspaceId: string;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  latestSequence: number;
}

export interface PendingInteraction {
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
  choices: Array<{ id: string; label: string; description?: string; destructive?: boolean }>;
  askUser?: {
    questions: Array<{
      index: number;
      question: string;
      options: Array<{ label: string; description?: string }>;
      multiSelect: boolean;
    }>;
    answers: Array<string | string[]>;
    currentQuestionIndex: number;
  };
  revision: number;
}

export interface Term2SubagentIdentity {
  agentId: string;
  role: string;
}

export type InteractionProjection =
  | null
  | {
      state: 'pending';
      interaction: PendingInteraction;
      turnId: string;
      /** Present only while the pending interaction belongs to a child run. */
      subagent?: Term2SubagentIdentity;
    }
  | {
      state: 'recovered';
      interaction: PendingInteraction;
      turnId: string;
      resolvable: false;
      reason: 'daemon_restart' | 'forced_shutdown' | 'persistence_recovery';
    };

export interface SessionProjection extends SessionListItem {
  earliestReplayableSequence: number;
  projectionSequence: number;
  transcript: unknown;
  interaction: InteractionProjection;
  sessionConfig?: SessionConfigRecord;
}

export interface AgentEventEnvelope {
  schemaVersion: 1;
  id: number;
  sessionId: string;
  type: Term2EventType;
  occurredAt: string;
  payload: Record<string, unknown>;
}

export interface SessionPage {
  sessions: SessionListItem[];
  nextCursor: string | null;
}
export interface WorkspacePage {
  workspaces: WorkspaceAlias[];
  nextCursor: string | null;
}

export type CandidateCheckStatus = 'ok' | 'error' | 'pending' | 'warning';
export interface CandidateValidation {
  candidateId?: string;
  displayName?: string;
  expiresAt?: number;
  checks: Array<{ name: string; status: CandidateCheckStatus }>;
  valid: boolean;
  selectable: boolean;
  reasonCode?: string;
  reason?: string;
}

export interface BrowseEntry {
  name: string;
  type: 'directory' | 'file' | 'symlink' | 'other';
  selectable: boolean;
  rejectionReason?: string;
  targetDisplay?: string;
  childToken?: string;
}

export interface BrowseResult {
  candidateId: string;
  entries: BrowseEntry[];
  truncated: boolean;
}

export type SettingSource = 'default' | 'config' | 'cli' | 'environment' | 'computed';
export type SettingValue = string | number | boolean | string[] | { model: string; provider: string } | null;
export interface SecretFreeCredential {
  configured: boolean;
  required: boolean;
  source: 'setting' | 'stored' | 'environment' | 'token-file' | 'local' | 'external' | 'missing';
  writable: boolean;
}
export interface OAuthAccountSummary {
  id: string;
  label: string;
  isSelected: boolean;
  isInUse: boolean;
}
export interface ModelSummary {
  provider: string;
  id: string;
  name?: string;
  default_reasoning_level?: string;
  contextWindow?: number;
}
export interface SettingsProjection {
  schemaVersion: number;
  revision: string;
  defaultsRevision: string;
  settings: {
    safeDefaults: Record<
      string,
      {
        value?: SettingValue;
        source: SettingSource;
        scope: 'global' | 'session';
        confirmRequired: boolean;
        /** Whether the browser may persist this key; non-persistable rows are read-only. */
        persistable: boolean;
      }
    >;
    credentials: Record<string, SecretFreeCredential>;
    providers: Array<{
      id: string;
      label: string;
      isCustom?: boolean;
      active: boolean;
      disabled?: boolean;
      credential: SecretFreeCredential;
      endpoint?: { host: string; path?: string };
    }>;
    oauthAccounts: Record<string, OAuthAccountSummary[]>;
    safety: {
      sandbox: 'enabled' | 'disabled' | 'unavailable';
      approval: 'off' | 'advisory' | 'auto' | 'unsafe-active' | 'hidden';
      backgroundShell: 'disabled-by-gateway';
      workspaceAccess: 'read' | 'read_write';
      network: 'denied' | 'configured' | 'confirmation-required';
    };
  };
  session?: SessionConfigRecord;
}
export interface SettingsWriteResult {
  committed: true;
  revision: string;
  projection: SettingsProjection;
}
export interface SessionConfigRecord {
  configRevision: string;
  providerId: string;
  modelId: string;
  reasoningEffort: string;
  mode: 'standard' | 'lite' | 'plan' | 'mentor' | 'orchestrator';
  defaultsRevision: string;
  toolPolicy?: {
    sandbox?: 'enabled' | 'disabled';
    approval?: 'off' | 'advisory' | 'auto';
    maxParallelToolCalls?: number;
    runBudget?: Record<string, number | string>;
    compaction?: Record<string, boolean | number | string | null>;
  };
}
export interface SessionConfigUpdate {
  modelSelection?: { model: string; provider: string };
  reasoningEffort?: string;
  mode?: SessionConfigRecord['mode'];
}
export interface MessageAdmission {
  sessionId: string;
  clientRequestId: string;
  turnId: string;
  accepted: true;
  replayed: boolean;
}
export interface AbortResult {
  sessionId: string;
  turnId: string;
  accepted: boolean;
  alreadySettled?: boolean;
}

export const TERM2_COMMAND_IDS = ['compact', 'retry-tool', 'retry-turn'] as const;
export type Term2CommandId = (typeof TERM2_COMMAND_IDS)[number];
// Contract 13 §8: the outcomes each session command may report, in one place so
// the wire validator and the contract pin cannot drift apart. The set is keyed by
// command because it is not shared — `failed` is the compaction failure outcome,
// and an accepted retry never reports a compaction outcome. The outcome type is
// the union of these lists, so no second copy of the vocabulary exists.
export const TERM2_COMMAND_OUTCOMES_BY_COMMAND = {
  compact: ['completed', 'not_reduced', 'nothing_to_retry', 'failed'],
  'retry-tool': ['accepted', 'nothing_to_retry'],
  'retry-turn': ['accepted', 'nothing_to_retry'],
} as const satisfies Record<Term2CommandId, readonly string[]>;
export type Term2CommandOutcome = (typeof TERM2_COMMAND_OUTCOMES_BY_COMMAND)[Term2CommandId][number];
export interface Term2CommandResult {
  commandId: Term2CommandId;
  outcome: Term2CommandOutcome;
  /** Bounded failure code; carried by a compact 'failed' outcome only. */
  reason?: string;
  turnId?: string;
  tokensBefore?: number;
  tokensAfter?: number;
  replayed?: boolean;
}
export interface InteractionResolveRequest {
  interactionId: string;
  revision: number;
  answer: string;
  rejectionReason?: string;
  approvalAnswer?: string;
}
export type InteractionResult =
  | {
      accepted: true;
      sessionId: string;
      turnId: string;
      interactionId: string;
    }
  | { accepted: false; interaction: PendingInteraction };

export type Term2ConnectionStatus =
  | 'idle'
  | 'hydrating'
  | 'connecting'
  | 'connected'
  | 'running'
  | 'awaiting_interaction'
  | 'aborting'
  | 'interrupted'
  | 'closed'
  | 'reconnecting'
  | 'error';
export interface Term2Command {
  callId: string;
  toolName: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'aborted' | 'unknown';
  argumentsText?: string;
  output?: string;
  error?: string;
}
export interface Term2SubagentToolUse {
  toolName: string;
  count: number;
}
export interface Term2SubagentCard {
  agentId: string;
  role: string;
  name?: string;
  task?: string;
  async?: boolean;
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  /** Latest subagent_text_turn progress; replaced, never accumulated. */
  progressText?: string;
  finalText?: string;
  finalTextTruncated?: boolean;
  toolsUsed?: Term2SubagentToolUse[];
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  error?: string;
  commands: Term2Command[];
}
export interface Term2TurnView {
  turnId: string;
  role: 'user' | 'assistant';
  userText?: string;
  text: string;
  reasoning: string;
  status: 'pending' | 'streaming' | 'completed' | 'failed' | 'aborted' | 'rejected';
  commands: Term2Command[];
  subagents?: Term2SubagentCard[];
  /** Transient turn-level note (retry/compaction); cleared on terminal events. */
  transientStatus?: string;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  error?: string;
}
export interface Term2SessionView {
  sessionId: string;
  projection: SessionProjection | null;
  turns: Term2TurnView[];
  pendingInteraction: InteractionProjection;
  status: Term2ConnectionStatus;
  lastAppliedSequence: number;
  error: string | null;
  reloadRequired: boolean;
}

export const INTERACTION_OUTCOMES = new Set<InteractionOutcome>(['approved', 'rejected', 'cancelled', 'continued']);

export class Term2ProtocolError extends Error {
  constructor(message: string, public readonly reloadRequired = true) {
    super(message);
    this.name = 'Term2ProtocolError';
  }
}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;
const OPTION_CHOICE_ID_PATTERN = /^option:[0-9]+$/;
const FIXED_CHOICE_IDS = new Set(['custom', 'decline', 'cancel']);
const SAFE_TEXT_MAX = 100_000;
function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Term2ProtocolError('Invalid term2 object');
  return value as Record<string, unknown>;
}
function stringValue(value: unknown, max = SAFE_TEXT_MAX): string {
  if (typeof value !== 'string' || value.length > max || /[\u0000\u007f]/u.test(value))
    throw new Term2ProtocolError('Invalid term2 text');
  return value;
}
function idValue(value: unknown): string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) throw new Term2ProtocolError('Invalid term2 identity');
  return value;
}
function choiceIdValue(value: unknown): string {
  if (
    typeof value !== 'string' ||
    (!ID_PATTERN.test(value) && !FIXED_CHOICE_IDS.has(value) && !OPTION_CHOICE_ID_PATTERN.test(value))
  )
    throw new Term2ProtocolError('Invalid term2 identity');
  return value;
}
function integerValue(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Term2ProtocolError('Invalid term2 sequence');
  return value as number;
}
const TRANSCRIPT_KEYS = new Set([
  'messages',
  'items',
  'entries',
  'turns',
  'id',
  'messageId',
  'turnId',
  'role',
  'type',
  'content',
  'text',
  'delta',
  'toolName',
  'callId',
  'argumentsText',
  'display',
  'command',
  'target',
  'scope',
  'warning',
  'status',
  'outcome',
  'occurredAt',
  'createdAt',
  'updatedAt',
  'usage',
  'inputTokens',
  'outputTokens',
  'totalTokens',
  'reason',
  'error',
  'version',
  'label',
  'description',
  'destructive',
  'choices',
  'displayPath',
  'displayParent',
  'sensitive',
  'metadata',
  'name',
  'value',
  'commands',
]);
const FORBIDDEN_KEYS = new Set([
  'ownerUserId',
  'localRoot',
  'canonicalRoot',
  'sshTargetId',
  'remoteRoot',
  'host',
  'username',
  'port',
  'agentProfileId',
  'identityFile',
  'identityFilePath',
  'privateKey',
  'keyMaterial',
  'SSH_AUTH_SOCK',
  'providerId',
  'providerResponseId',
  'rawInterruption',
  'stack',
  'stackTrace',
  'credential',
  'credentials',
  'path',
  'filePath',
  'cwd',
  'projectPath',
  'root',
  'sshHost',
  'sshPort',
]);
const TRANSCRIPT_COMMAND_STATUSES = new Set(['completed', 'failed', 'aborted', 'unknown']);

function validateTranscriptCommands(value: unknown): void {
  if (!Array.isArray(value) || value.length > 64) throw new Term2ProtocolError('Invalid transcript commands');
  for (const item of value) {
    const command = objectValue(item);
    exactKeys(command, ['callId', 'toolName', 'status']);
    if (
      typeof command.callId !== 'string' ||
      command.callId.length === 0 ||
      command.callId.length > 256 ||
      typeof command.toolName !== 'string' ||
      command.toolName.length === 0 ||
      command.toolName.length > 256 ||
      !TRANSCRIPT_COMMAND_STATUSES.has(String(command.status))
    )
      throw new Term2ProtocolError('Invalid transcript command');
    stringValue(command.callId, 256);
    stringValue(command.toolName, 256);
  }
}

function validateTranscript(value: unknown, depth = 0): void {
  if (depth > 12) throw new Term2ProtocolError('Transcript is too deep');
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return;
  if (typeof value === 'string') {
    stringValue(value);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 1000) throw new Term2ProtocolError('Transcript is too large');
    value.forEach((item) => validateTranscript(item, depth + 1));
    return;
  }
  const object = objectValue(value);
  if (Object.prototype.hasOwnProperty.call(object, 'commands')) {
    if (object.role !== 'bot') throw new Term2ProtocolError('Transcript commands require bot role');
    validateTranscriptCommands(object.commands);
  }
  for (const [key, child] of Object.entries(object)) {
    if (FORBIDDEN_KEYS.has(key) || !TRANSCRIPT_KEYS.has(key))
      throw new Term2ProtocolError('Transcript contains an unsafe field');
    validateTranscript(child, depth + 1);
  }
}
function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[] = allowed,
): void {
  const keys = Object.keys(value);
  if (
    keys.some((key) => !allowed.includes(key)) ||
    required.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
  )
    throw new Term2ProtocolError('Unknown or missing term2 field');
}

export function parsePendingInteraction(value: unknown): PendingInteraction {
  const input = objectValue(value);
  exactKeys(
    input,
    ['version', 'interactionId', 'kind', 'variant', 'descriptor', 'choices', 'askUser', 'revision'],
    ['version', 'interactionId', 'kind', 'variant', 'descriptor', 'choices', 'revision'],
  );
  if (
    input.version !== 1 ||
    !['tool_approval', 'ask_user', 'check_in'].includes(String(input.kind)) ||
    ![
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
    ].includes(String(input.variant))
  )
    throw new Term2ProtocolError('Invalid interaction');
  const descriptor = objectValue(input.descriptor);
  exactKeys(
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
  const choices = Array.isArray(input.choices) ? input.choices : [];
  const result: PendingInteraction = {
    version: 1,
    interactionId: idValue(input.interactionId),
    kind: input.kind as InteractionKind,
    variant: input.variant as InteractionVariant,
    descriptor: {
      agentName: stringValue(descriptor.agentName, 256),
      toolName: stringValue(descriptor.toolName, 256),
      argumentsText: stringValue(descriptor.argumentsText, 8192),
    },
    choices: choices.map((choice) => {
      const item = objectValue(choice);
      exactKeys(item, ['id', 'label', 'description', 'destructive'], ['id', 'label']);
      if (item.destructive !== undefined && typeof item.destructive !== 'boolean')
        throw new Term2ProtocolError('Invalid choice');
      return {
        id: choiceIdValue(item.id),
        label: stringValue(item.label, 512),
        ...(item.description === undefined ? {} : { description: stringValue(item.description, 2000) }),
        ...(item.destructive === undefined ? {} : { destructive: item.destructive === true }),
      };
    }),
    revision: integerValue(input.revision),
  };
  if (descriptor.callId !== undefined) result.descriptor.callId = idValue(descriptor.callId);
  if (descriptor.checkIn !== undefined) {
    if (!['max_turns', 'run_budget'].includes(String(descriptor.checkIn)))
      throw new Term2ProtocolError('Invalid check-in');
    result.descriptor.checkIn = descriptor.checkIn as 'max_turns' | 'run_budget';
  }
  if (descriptor.display !== undefined) {
    const display = objectValue(descriptor.display);
    exactKeys(display, ['command', 'target', 'scope', 'warning'], []);
    result.descriptor.display = Object.fromEntries(
      Object.entries(display).map(([key, value]) => [key, stringValue(value, 2000)]),
    ) as NonNullable<PendingInteraction['descriptor']['display']>;
  }
  if (descriptor.llmAdvisory !== undefined) {
    const advisory = objectValue(descriptor.llmAdvisory);
    exactKeys(advisory, ['reasoning', 'approved', 'model', 'riskLevel'], ['reasoning', 'approved', 'model']);
    if (typeof advisory.approved !== 'boolean') throw new Term2ProtocolError('Invalid advisory');
    result.descriptor.llmAdvisory = {
      reasoning: stringValue(advisory.reasoning),
      approved: advisory.approved,
      model: stringValue(advisory.model, 256),
      ...(advisory.riskLevel === undefined ? {} : { riskLevel: stringValue(advisory.riskLevel, 256) }),
    };
  }
  if (descriptor.deniedRead !== undefined) {
    const denied = objectValue(descriptor.deniedRead);
    exactKeys(denied, ['displayPath', 'displayParent', 'sensitive']);
    if (typeof denied.sensitive !== 'boolean') throw new Term2ProtocolError('Invalid denied-read descriptor');
    result.descriptor.deniedRead = {
      displayPath: stringValue(denied.displayPath, 2000),
      displayParent: stringValue(denied.displayParent, 2000),
      sensitive: denied.sensitive,
    };
  }
  if (descriptor.runBudgetEvidence !== undefined) {
    const evidence = objectValue(descriptor.runBudgetEvidence);
    if (
      Object.keys(evidence).length > 32 ||
      Object.values(evidence).some((value) => !Number.isSafeInteger(value) || (value as number) < 0)
    )
      throw new Term2ProtocolError('Invalid run budget evidence');
    result.descriptor.runBudgetEvidence = evidence as Record<string, number>;
  }
  if (input.askUser !== undefined) {
    const ask = objectValue(input.askUser);
    exactKeys(ask, ['questions', 'answers', 'currentQuestionIndex']);
    if (!Array.isArray(ask.questions) || !Array.isArray(ask.answers))
      throw new Term2ProtocolError('Invalid ask-user interaction');
    result.askUser = {
      questions: ask.questions.map((question) => {
        const item = objectValue(question);
        exactKeys(item, ['index', 'question', 'options', 'multiSelect']);
        if (typeof item.multiSelect !== 'boolean') throw new Term2ProtocolError('Invalid ask-user question');
        const options = Array.isArray(item.options) ? item.options : [];
        return {
          index: integerValue(item.index),
          question: stringValue(item.question, 10_000),
          options: options.map((option) => {
            const opt = objectValue(option);
            exactKeys(opt, ['label', 'description'], ['label']);
            return {
              label: stringValue(opt.label, 512),
              ...(opt.description === undefined ? {} : { description: stringValue(opt.description, 2000) }),
            };
          }),
          multiSelect: item.multiSelect === true,
        };
      }),
      answers: ask.answers.map((answer) =>
        Array.isArray(answer) ? answer.map((item) => stringValue(item, 10_000)) : stringValue(answer, 10_000),
      ),
      currentQuestionIndex: integerValue(ask.currentQuestionIndex),
    };
  }
  if (result.kind === 'ask_user' && result.variant !== 'ask_user')
    throw new Term2ProtocolError('Invalid ask-user variant');
  return result;
}

export function parseProjection(value: unknown): SessionProjection {
  const input = objectValue(value);
  exactKeys(
    input,
    [
      'id',
      'workspaceId',
      'status',
      'createdAt',
      'updatedAt',
      'latestSequence',
      'earliestReplayableSequence',
      'projectionSequence',
      'transcript',
      'interaction',
      'sessionConfig',
    ],
    [
      'id',
      'workspaceId',
      'status',
      'createdAt',
      'updatedAt',
      'latestSequence',
      'earliestReplayableSequence',
      'projectionSequence',
      'transcript',
      'interaction',
    ],
  );
  const projection: SessionProjection = {
    id: idValue(input.id),
    workspaceId: idValue(input.workspaceId),
    status: input.status as SessionStatus,
    createdAt: stringValue(input.createdAt, 128),
    updatedAt: stringValue(input.updatedAt, 128),
    latestSequence: integerValue(input.latestSequence),
    earliestReplayableSequence: integerValue(input.earliestReplayableSequence),
    projectionSequence: integerValue(input.projectionSequence),
    transcript: input.transcript,
    interaction: null,
  };
  if (input.sessionConfig !== undefined) {
    const config = objectValue(input.sessionConfig);
    exactKeys(config, [
      'configRevision',
      'providerId',
      'modelId',
      'reasoningEffort',
      'mode',
      'defaultsRevision',
      'toolPolicy',
    ]);
    if (!['standard', 'lite', 'plan', 'mentor', 'orchestrator'].includes(String(config.mode)))
      throw new Term2ProtocolError('Invalid session config');
    projection.sessionConfig = {
      configRevision: stringValue(config.configRevision, 256),
      providerId: stringValue(config.providerId, 256),
      modelId: stringValue(config.modelId, 512),
      reasoningEffort: stringValue(config.reasoningEffort, 128),
      mode: config.mode as SessionConfigRecord['mode'],
      defaultsRevision: stringValue(config.defaultsRevision, 256),
      ...(config.toolPolicy === undefined
        ? {}
        : { toolPolicy: config.toolPolicy as SessionConfigRecord['toolPolicy'] }),
    };
  }
  if (!['idle', 'running', 'awaiting_interaction', 'interrupted', 'closed'].includes(projection.status))
    throw new Term2ProtocolError('Invalid session status');
  validateTranscript(input.transcript);
  if (input.interaction !== null && input.interaction !== undefined) {
    const interaction = objectValue(input.interaction);
    exactKeys(
      interaction,
      ['state', 'interaction', 'turnId', 'resolvable', 'reason'],
      ['state', 'interaction', 'turnId'],
    );
    const parsed = parsePendingInteraction(interaction.interaction);
    if (interaction.state === 'pending') {
      if (interaction.resolvable !== undefined || interaction.reason !== undefined)
        throw new Term2ProtocolError('Invalid pending interaction projection');
      projection.interaction = {
        state: 'pending',
        interaction: parsed,
        turnId: idValue(interaction.turnId),
      };
    } else if (
      interaction.state === 'recovered' &&
      interaction.resolvable === false &&
      ['daemon_restart', 'forced_shutdown', 'persistence_recovery'].includes(String(interaction.reason))
    )
      projection.interaction = {
        state: 'recovered',
        interaction: parsed,
        turnId: idValue(interaction.turnId),
        resolvable: false,
        reason: interaction.reason as 'daemon_restart' | 'forced_shutdown' | 'persistence_recovery',
      };
    else throw new Term2ProtocolError('Invalid interaction projection');
  }
  return projection;
}

export function parseEventEnvelope(value: unknown, expectedSessionId?: string): AgentEventEnvelope {
  const input = objectValue(value);
  exactKeys(input, ['schemaVersion', 'id', 'sessionId', 'type', 'occurredAt', 'payload']);
  if (input.schemaVersion !== 1 || !TERM2_EVENT_TYPE_SET.has(String(input.type)))
    throw new Term2ProtocolError('Unsupported term2 event');
  const event: AgentEventEnvelope = {
    schemaVersion: 1,
    id: integerValue(input.id),
    sessionId: idValue(input.sessionId),
    type: input.type as Term2EventType,
    occurredAt: stringValue(input.occurredAt, 128),
    payload: objectValue(input.payload),
  };
  if (event.id < 1 || (expectedSessionId && event.sessionId !== expectedSessionId))
    throw new Term2ProtocolError('Event identity mismatch');
  return event;
}
