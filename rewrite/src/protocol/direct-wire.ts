/** Direct public protocol. No engine tokens, provider history or live callbacks cross this boundary.
 * The unprefixed exports in index.ts still serve the isolated bridge, not this runtime.
 */
export const DIRECT_PROTOCOL_VERSION = 1 as const;
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type WireModel = { readonly provider: string; readonly model: string };
export type WireContent =
  | { readonly type: 'text'; readonly text: string }
  /** data is raw RFC 4648 base64 bytes, NOT a data URI/path/URL. Provider policy stays Session-owned. */
  | { readonly type: 'image'; readonly mediaType: string; readonly data: string; readonly detail?: string };
export type WireStatus = 'idle' | 'running' | 'awaiting_interaction' | 'interrupted' | 'closed';
export type WireUsage = { readonly inputTokens: number; readonly outputTokens: number; readonly cachedInputTokens: number };
export type WireGrant = 'allow-remember' | 'unsandboxed-once' | 'allow-folder-session' | 'allow-edit-file-session' | 'allow-edit-folder-session' | 'docker-allow-once' | 'docker-allow-session' | 'docker-allow-project';
export type WireQuestion = { readonly id: string; readonly prompt: string; readonly options: readonly { readonly label: string; readonly description?: string }[]; readonly multiple: boolean; readonly allowCustom: boolean };
export type WireQuestionAnswer = { readonly questionId: string; readonly value: string | readonly string[] };
export type WireDecision = (
  | { readonly kind: 'allow' }
  | { readonly kind: 'decline' }
  | { readonly kind: 'deny'; readonly reason?: string }
  | { readonly kind: 'answer'; readonly answer: string }
  | { readonly kind: 'answers'; readonly answers: readonly WireQuestionAnswer[] }
  | { readonly kind: 'grant'; readonly grant: WireGrant }
) & { readonly stopAfterApprovalResolution?: boolean };
export type WireInteraction = {
  readonly requestId: string;
  readonly turnId: string;
  readonly executionId?: string;
  readonly parentExecutionId?: string;
  readonly kind: 'approval' | 'question';
  readonly toolName: string;
  readonly input: JsonValue;
  readonly summary: string;
  readonly detail?: string;
  readonly risk?: 'low' | 'medium' | 'high';
  readonly presentation?: { readonly [key: string]: JsonValue };
  readonly questions?: readonly WireQuestion[];
  /** Only explicitly supported grants may be offered; empty under the M2 contract. */
  readonly supportedGrants: readonly WireGrant[];
};
export type WireMessage = {
  readonly id: string;
  readonly role: 'user' | 'assistant' | 'tool';
  readonly content: readonly WireContent[];
  readonly text: string;
  readonly turnId?: string;
  readonly modelStep?: number;
  readonly executionId?: string;
  readonly isError?: boolean;
  readonly draft?: boolean;
};
export type WireTool = {
  readonly executionId: string;
  readonly turnId: string;
  readonly parentExecutionId?: string;
  readonly callId?: string;
  readonly toolName: string;
  readonly input: JsonValue;
  readonly status: 'called' | 'started' | 'completed' | 'unknown';
  readonly output?: string;
  readonly isError?: boolean;
  readonly progress?: string;
  readonly display?: JsonValue;
  readonly content?: readonly WireContent[];
};
export type WireOrigin = { readonly kind: 'cli' | 'tui' | 'acp' | 'control' | 'discord' | 'api'; readonly id?: string };
export type WireAdmission =
  | { readonly kind: 'started' | 'queued' | 'steering'; readonly clientRequestId: string; readonly messageId: string; readonly turnId?: string }
  | { readonly kind: 'duplicate'; readonly clientRequestId: string; readonly original: Exclude<WireAdmission, { readonly kind: 'duplicate' }> }
  | { readonly kind: 'rejected'; readonly clientRequestId: string; readonly reason: string };
export type WireQueueEntry = { readonly messageId: string; readonly text: string; readonly delivery: 'queued' | 'steering'; readonly clientRequestId: string };
export type WireTask = { readonly id: string; readonly turnId?: string; readonly agentId?: string; readonly role?: string; readonly status: 'running' | 'awaiting_interaction' | 'completed' | 'cancelled' | 'failed' | 'interrupted'; readonly text?: string };
export type WireRetry = { readonly turn: boolean; readonly tool: boolean };
export type WireError = { readonly kind: string; readonly message: string; readonly retryable?: boolean };
export type WireNotice = { readonly kind: string; readonly message: string };
export type WireGoal = { readonly id: string; readonly text: string; readonly status: 'active' | 'blocked' | 'completed' | 'cancelled' };
export type WireVerification = { readonly status: 'pending' | 'running' | 'passed' | 'blocked' | 'failed'; readonly message?: string };
export type WireConfiguration = { readonly model?: WireModel; readonly reasoning?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'; readonly temperature?: number };
export type WireCancelTarget = { readonly kind: 'foreground' } | { readonly kind: 'task'; readonly id: string };
export type WireRewindTarget = { readonly id: string; readonly label: string };

/** seq is a durable cursor, never the Session's private publication position.
 * null means the currently minimal facade cannot supply that cursor yet.
 */
export type WireSnapshot = {
  readonly protocolVersion: typeof DIRECT_PROTOCOL_VERSION;
  readonly sessionId: string;
  readonly seq: number | null;
  readonly status: WireStatus;
  readonly model: WireModel;
  readonly configuration: WireConfiguration;
  readonly activeTurnId: string | null;
  readonly messages: readonly WireMessage[];
  readonly tools: readonly WireTool[];
  readonly pendingInteractions: readonly WireInteraction[];
  readonly admissions: readonly WireAdmission[];
  readonly usage: WireUsage;
  readonly reasoning: string;
  readonly retryEligibility: WireRetry;
  readonly queue: readonly WireQueueEntry[];
  readonly queueState: 'idle' | 'running' | 'paused' | 'cancelling' | 'completing' | 'awaiting_action' | 'awaiting_preflight';
  readonly tasks: readonly WireTask[];
  readonly cost: { readonly totalUsd: number; readonly currency: 'USD' } | null;
  readonly goal: WireGoal | null;
  readonly verification: WireVerification | null;
  readonly notices: readonly WireNotice[];
  readonly lastError: WireError | null;
  readonly terminal: { readonly turnId: string; readonly outcome: 'completed' | 'cancelled' | 'failed' | 'interrupted'; readonly error?: WireError } | null;
  /** null means the facade cannot yet supply authoritative mixed transcript ordering. */
  readonly timeline: readonly { readonly kind: 'message' | 'tool'; readonly id: string }[] | null;
};

export type WireEventPayloads = {
  snapshot: { readonly snapshot: WireSnapshot };
  turn_started: { readonly input: readonly WireMessage[]; readonly foreground: boolean };
  text_delta: { readonly delta: string; readonly messageId: string; readonly modelStep: number };
  reasoning_delta: { readonly delta: string; readonly modelStep: number | null; readonly messageId: string | null };
  message: { readonly message: WireMessage; readonly replacesDraftId?: string };
  tool_called: { readonly tool: WireTool };
  tool_started: { readonly tool: WireTool };
  tool_progress: { readonly executionId: string; readonly chunk: string };
  tool_finished: { readonly executionId: string; readonly output: string; readonly isError: boolean; readonly display?: JsonValue; readonly content?: readonly WireContent[] };
  interaction_opened: { readonly interaction: WireInteraction };
  interaction_resolved: { readonly requestId: string; readonly resolution: WireDecision | { readonly kind: 'cancelled' | 'interrupted' } };
  admission: { readonly admission: WireAdmission };
  usage: { readonly usage: WireUsage };
  status_changed: { readonly status: WireStatus };
  turn_ended: { readonly outcome: 'completed' | 'cancelled' | 'failed' | 'interrupted'; readonly error?: WireError };
  retrying: { readonly attempt: number; readonly delayMs: number; readonly error: WireError };
  retry_eligibility: WireRetry;
  configuration: WireConfiguration;
  queue_changed: { readonly entries: readonly WireQueueEntry[]; readonly state: WireSnapshot['queueState'] };
  task_changed: { readonly task: WireTask };
  subagent: { readonly agentId: string; readonly role: string; readonly event: WireEvent };
  compacted: { readonly replaced: number; readonly summaryId: string };
  cost: { readonly totalUsd: number; readonly currency: 'USD' };
  notice: WireNotice;
  goal: { readonly goal: WireGoal | null };
  verification: { readonly verification: WireVerification | null };
  error: { readonly error: WireError };
};
export type WireEventType = keyof WireEventPayloads;
export type WireEvent = { [K in WireEventType]: {
  readonly sessionId: string;
  readonly seq: number | null;
  readonly turnId: string | null;
  readonly type: K;
  readonly payload: WireEventPayloads[K];
} }[WireEventType];

export type WireSubmission = { readonly requestId: string; readonly text: string; readonly attachments?: readonly WireContent[]; readonly origin?: WireOrigin; readonly delivery?: 'auto' | 'steer' | 'follow_up' | 'reject_if_busy' };
export type WireCommand =
  | ({ readonly type: 'submit' } & WireSubmission)
  | { readonly type: 'answer'; readonly requestId: string; readonly decision: WireDecision }
  | { readonly type: 'cancel'; readonly target?: WireCancelTarget }
  | { readonly type: 'retry'; readonly target: 'turn' | 'tool'; readonly executionId?: string }
  | { readonly type: 'compact' }
  | { readonly type: 'configure'; readonly configuration: WireConfiguration }
  | { readonly type: 'queue_edit'; readonly messageId: string; readonly text: string; readonly attachments?: readonly WireContent[] }
  | { readonly type: 'queue_retract'; readonly messageId: string }
  | { readonly type: 'queue_resume' }
  | { readonly type: 'queue_discard' }
  | { readonly type: 'task_control'; readonly taskId: string; readonly action: 'cancel' | 'check_in' | 'foreground' }
  | { readonly type: 'list_rewind_targets' }
  | { readonly type: 'rewind'; readonly targetId: string }
  | { readonly type: 'reset' }
  | { readonly type: 'rollover' }
  | { readonly type: 'preview'; readonly text: string; readonly attachments?: readonly WireContent[] };
export type WireCommandErrorCode = 'invalid_command' | 'unavailable' | 'stale_interaction' | 'request_conflict' | 'rejected' | 'closed' | 'not_found' | 'forbidden' | 'storage_failure' | 'internal_error' | 'replay_unavailable';
export type WireCommandResult =
  | { readonly ok: true; readonly kind: 'admitted'; readonly admission: WireAdmission }
  | { readonly ok: true; readonly kind: 'accepted' }
  | { readonly ok: true; readonly kind: 'rewind_targets'; readonly targets: readonly WireRewindTarget[] }
  | { readonly ok: true; readonly kind: 'preview'; readonly notices: readonly WireNotice[]; readonly requiresConfirmation: boolean }
  | { readonly ok: true; readonly kind: 'rewound'; readonly draft: { readonly text: string; readonly attachments: readonly WireContent[] } | null }
  | { readonly ok: true; readonly kind: 'session_changed'; readonly sessionId: string }
  | { readonly ok: false; readonly code: WireCommandErrorCode; readonly message: string };
