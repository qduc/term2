/**
 * Authoritative TypeScript / Zod schema for the Term2 Client API v1.1 (backward-compatible over v1.0).
 * Self-contained (depends only on `zod`) for future graduation into @qduc/agent-wire (Decision D006).
 * Generates `docs/plans/daemon/spec/client-api.schema.json` via `scripts/generate-client-api-schema.mjs`.
 *
 * Strictness policy (client-api.md §3.2):
 * - C -> H request schemas & Unix request/response frame envelopes use `z.strictObject(...)`
 *   so unrecognized fields fail identically in TypeScript runtime and JSON Schema validation.
 * - H -> C response & event payload schemas use `z.looseObject(...)` so minor-version
 *   additive properties remain forward-compatible in both Zod and generated JSON Schema.
 */
import { z } from 'zod';
import { CLIENT_API_SCHEMAS_V11 } from './client-api-schema-v11.js';

export type {
  DaemonServeStartParams,
  ModelsListParamsV11,
  ProviderUpsertParamsV11,
  SessionControlBindParams,
  SessionLaunchParams,
  SessionLaunchResult,
  SettingsUpdateParamsV11,
} from './client-api-schema-v11.js';

// --- Primitives (client-api.md §1.1) ---

const NonNegativeInt = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const PositiveInt = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const VersionString = z.string().regex(/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/);
const UtcTimestamp = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/);
const OpaqueId = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/);
const ControlFreeString = z
  .string()
  .min(1)
  .regex(/^[^\x00-\x1F\x7F]+$/);
const ClientKind = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/);

export const CLIENT_API_HTTP_CAPABILITIES = [
  'session_list_stream',
  'settings_stream',
  'daemon_control',
  'mcp',
] as const;
export const CLIENT_API_CAPABILITIES = [...CLIENT_API_HTTP_CAPABILITIES, 'local_leases'] as const;

const CLIENT_API_ERROR_CODES = [
  'protocol_incompatible',
  'unauthorized',
  'forbidden',
  'not_found',
  'invalid_request',
  'stale_revision',
  'stale_interaction',
  'busy',
  'cursor_out_of_range',
  'env_disconnected',
  'unavailable',
  'closed',
  'internal_error',
] as const;

const ClientApiErrorCodeSchema = z.enum(CLIENT_API_ERROR_CODES);

const ClientApiErrorSchema = z.looseObject({
  code: ClientApiErrorCodeSchema,
  message: z.string().min(1),
  retryable: z.boolean().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});

// --- Handshake & Daemon Control (client-api.md §3) ---

const ProtocolHelloParamsSchema = z.strictObject({
  protocolVersion: VersionString,
  minSupportedVersion: VersionString,
  clientKind: ClientKind,
  clientVersion: ControlFreeString,
  capabilities: z.array(ControlFreeString).optional(),
});

const ProtocolWelcomeResultSchema = z.looseObject({
  protocolVersion: VersionString,
  daemonId: OpaqueId,
  daemonVersion: ControlFreeString,
  pid: PositiveInt.optional(),
  capabilities: z.array(ControlFreeString),
  upgradeRecommended: z.boolean().optional(),
});

const DaemonStatusResultSchema = z.looseObject({
  daemonId: OpaqueId,
  daemonVersion: ControlFreeString,
  protocolVersion: VersionString,
  pid: PositiveInt,
  startedAt: UtcTimestamp,
  activeSessionCount: NonNegativeInt,
  activeTurnCount: NonNegativeInt,
  activeBackgroundTaskCount: NonNegativeInt,
  attachedClientCount: NonNegativeInt,
});

const DaemonShutdownParamsSchema = z.strictObject({
  mode: z.enum(['graceful', 'immediate']),
  whenIdle: z.boolean().optional(),
  timeoutMs: PositiveInt.optional(),
  onTimeout: z.enum(['cancel', 'abort']).optional(),
});

const DaemonDrainingEventSchema = z.looseObject({
  reason: z.enum(['shutdown', 'restart']),
  gracePeriodMs: NonNegativeInt,
});

const ProtocolHeartbeatEventSchema = z.looseObject({
  now: UtcTimestamp,
});

// --- Session Catalog & Session-List Stream (client-api.md §5) ---

const SessionStatusSchema = z.enum(['idle', 'running', 'awaiting_interaction', 'interrupted', 'closed']);

const AwaitingKindSchema = z.enum(['approval', 'question', 'budget']);

const SessionModelSummarySchema = z.strictObject({
  provider: ControlFreeString,
  model: ControlFreeString,
});

const SessionModelSummaryOutSchema = z.looseObject({
  provider: ControlFreeString,
  model: ControlFreeString,
});

const SessionListItemSchema = z.looseObject({
  id: ControlFreeString,
  workspaceId: OpaqueId,
  workspaceRoot: ControlFreeString.optional(),
  status: SessionStatusSchema,
  awaitingKind: AwaitingKindSchema.optional(),
  createdAt: UtcTimestamp,
  updatedAt: UtcTimestamp,
  latestSequence: NonNegativeInt,
  title: ControlFreeString.max(120).optional(),
  model: SessionModelSummaryOutSchema.optional(),
  messageCount: NonNegativeInt.optional(),
  pendingInteractionCount: NonNegativeInt.optional(),
  activeBackgroundTaskCount: NonNegativeInt.optional(),
});

const SessionListParamsSchema = z.strictObject({
  limit: PositiveInt.max(100).optional(),
  cursor: z.string().min(1).optional(),
  workspaceId: OpaqueId.optional(),
});

const SessionListResultSchema = z.looseObject({
  sessions: z.array(SessionListItemSchema),
  nextCursor: z.string().min(1).nullable(),
});

const SessionListSubscribeParamsSchema = z.strictObject({
  workspaceId: OpaqueId.optional(),
  limit: PositiveInt.max(500).optional(),
});

const SessionListSnapshotEventSchema = z.looseObject({
  streamEpoch: OpaqueId,
  sessions: z.array(SessionListItemSchema),
  truncated: z.boolean(),
  nextCursor: z.string().min(1).nullable(),
});

const SessionListUpsertEventSchema = z.looseObject({
  session: SessionListItemSchema,
});

const SessionListRemoveEventSchema = z.looseObject({
  sessionId: ControlFreeString,
  reason: z.enum(['workspace_revoked', 'deleted']),
});

const SessionListResyncRequiredEventSchema = z.looseObject({
  reason: z.enum(['slow_consumer', 'epoch_changed']),
});

const SessionApprovalPolicySchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('interactive') }),
  z.strictObject({ mode: z.literal('headless'), autoApprove: z.boolean() }),
]);

/** Exactly one of `workspaceId` or `cwd` MUST be supplied (client-api.md §5.3). */
const SessionCreateParamsSchema = z.union([
  z.strictObject({
    workspaceId: OpaqueId,
    model: SessionModelSummarySchema.optional(),
    approvalPolicy: SessionApprovalPolicySchema.optional(),
    includeSnapshot: z.boolean().optional(),
  }),
  z.strictObject({
    cwd: ControlFreeString,
    model: SessionModelSummarySchema.optional(),
    approvalPolicy: SessionApprovalPolicySchema.optional(),
    includeSnapshot: z.boolean().optional(),
  }),
]);

const SessionCreateResultSchema = z.looseObject({
  session: SessionListItemSchema,
  snapshot: z.record(z.string(), z.unknown()).optional(),
});

const SessionForkParamsSchema = z.strictObject({
  sourceSessionId: ControlFreeString,
});

const SessionHandoffParamsSchema = z.strictObject({
  sourceSessionId: ControlFreeString,
  name: ControlFreeString.optional(),
  text: z.string().optional(),
});

const SessionCloseParamsSchema = z.strictObject({
  sessionId: ControlFreeString,
  force: z.boolean().optional(),
});

// --- Session Attachment, Stream & Replay (client-api.md §6) ---

const SessionAttachParamsSchema = z.strictObject({
  sessionId: ControlFreeString,
  fromSeq: NonNegativeInt.optional(),
  sessionEpoch: ControlFreeString.optional(),
});

const SessionSnapshotEventSchema = z.looseObject({
  sessionId: ControlFreeString,
  seq: NonNegativeInt,
  earliestReplayableSequence: PositiveInt,
  sessionEpoch: ControlFreeString,
  snapshot: z.record(z.string(), z.unknown()),
});

const SessionAcceptedEventSchema = z.looseObject({
  sessionId: ControlFreeString,
  seq: PositiveInt,
  occurredAt: UtcTimestamp,
  events: z.array(z.record(z.string(), z.unknown())),
});

const SessionLiveEventSchema = z.looseObject({
  sessionId: ControlFreeString,
  events: z.array(z.record(z.string(), z.unknown())).min(1),
});

const SessionResyncRequiredEventSchema = z.looseObject({
  sessionId: ControlFreeString,
  reason: z.enum(['slow_consumer', 'session_rotated']),
  earliestReplayableSequence: PositiveInt,
  latestSequence: NonNegativeInt,
});

const SessionClosedEventSchema = z.looseObject({
  sessionId: ControlFreeString,
  reason: z.enum(['closed', 'workspace_revoked', 'daemon_shutdown']),
});

// --- Session Commands & Global Configuration (client-api.md §§7-9) ---

const SessionCommandParamsSchema = z.strictObject({
  sessionId: ControlFreeString,
  command: z.record(z.string(), z.unknown()),
});

const WorkspaceScopeParamsSchema = z.strictObject({
  workspaceId: OpaqueId.optional(),
  sessionId: ControlFreeString.optional(),
});
const WorkspaceFilesParamsSchema = WorkspaceScopeParamsSchema.extend({
  refresh: z.boolean().optional(),
});

const SettingsUpdateParamsSchema = z.strictObject({
  expectedRevision: ControlFreeString,
  changes: z.array(z.strictObject({ key: ControlFreeString, value: z.unknown() })).min(1),
});

const SettingsStateEventSchema = z.looseObject({
  revision: ControlFreeString,
  settings: z.record(z.string(), z.unknown()),
});

// --- Unix Domain Socket Transport Binding (transport-unix.md §§2-3) ---

const UnixSessionAttachResultSchema = z.looseObject({
  streamId: OpaqueId,
  mode: z.enum(['snapshot', 'replay']),
  sessionEpoch: ControlFreeString,
  earliestReplayableSequence: PositiveInt,
});

const UnixStreamUnsubscribeParamsSchema = z.strictObject({
  streamId: OpaqueId,
});

const UnixRequestFrameSchema = z.strictObject({
  kind: z.literal('request'),
  id: ControlFreeString,
  method: ControlFreeString,
  params: z.record(z.string(), z.unknown()).optional(),
});

const UnixResponseFrameSchema = z.discriminatedUnion('ok', [
  z.strictObject({
    kind: z.literal('response'),
    id: ControlFreeString,
    ok: z.literal(true),
    result: z.record(z.string(), z.unknown()),
  }),
  z.strictObject({
    kind: z.literal('response'),
    id: ControlFreeString,
    ok: z.literal(false),
    error: ClientApiErrorSchema,
  }),
]);

const UnixEventFrameSchema = z.strictObject({
  kind: z.literal('event'),
  streamId: OpaqueId.optional(),
  event: ControlFreeString,
  payload: z.record(z.string(), z.unknown()),
});

const UnixFrameSchema = z.discriminatedUnion('kind', [
  UnixRequestFrameSchema,
  UnixResponseFrameSchema,
  UnixEventFrameSchema,
]);

export const CLIENT_API_SCHEMAS = {
  error: ClientApiErrorSchema,
  protocolHelloParams: ProtocolHelloParamsSchema,
  protocolWelcomeResult: ProtocolWelcomeResultSchema,
  daemonStatusResult: DaemonStatusResultSchema,
  daemonShutdownParams: DaemonShutdownParamsSchema,
  daemonDrainingEvent: DaemonDrainingEventSchema,
  protocolHeartbeatEvent: ProtocolHeartbeatEventSchema,
  sessionListItem: SessionListItemSchema,
  sessionListParams: SessionListParamsSchema,
  sessionListResult: SessionListResultSchema,
  sessionListSubscribeParams: SessionListSubscribeParamsSchema,
  sessionListSnapshotEvent: SessionListSnapshotEventSchema,
  sessionListUpsertEvent: SessionListUpsertEventSchema,
  sessionListRemoveEvent: SessionListRemoveEventSchema,
  sessionListResyncRequiredEvent: SessionListResyncRequiredEventSchema,
  sessionApprovalPolicy: SessionApprovalPolicySchema,
  sessionCreateParams: SessionCreateParamsSchema,
  sessionCreateResult: SessionCreateResultSchema,
  sessionForkParams: SessionForkParamsSchema,
  sessionHandoffParams: SessionHandoffParamsSchema,
  sessionCloseParams: SessionCloseParamsSchema,
  sessionAttachParams: SessionAttachParamsSchema,
  sessionSnapshotEvent: SessionSnapshotEventSchema,
  sessionAcceptedEvent: SessionAcceptedEventSchema,
  sessionLiveEvent: SessionLiveEventSchema,
  sessionResyncRequiredEvent: SessionResyncRequiredEventSchema,
  sessionClosedEvent: SessionClosedEventSchema,
  sessionCommandParams: SessionCommandParamsSchema,
  settingsUpdateParams: SettingsUpdateParamsSchema,
  settingsStateEvent: SettingsStateEventSchema,
  skillsListParams: WorkspaceScopeParamsSchema,
  workspaceFilesParams: WorkspaceFilesParamsSchema,
  unixSessionAttachResult: UnixSessionAttachResultSchema,
  unixStreamUnsubscribeParams: UnixStreamUnsubscribeParamsSchema,
  unixRequestFrame: UnixRequestFrameSchema,
  unixResponseFrame: UnixResponseFrameSchema,
  unixEventFrame: UnixEventFrameSchema,
  unixFrame: UnixFrameSchema,
  ...CLIENT_API_SCHEMAS_V11,
} as const;

export type ClientApiErrorCode = z.infer<typeof ClientApiErrorCodeSchema>;
export type ClientApiError = z.infer<typeof ClientApiErrorSchema>;
export type ProtocolHelloParams = z.infer<typeof ProtocolHelloParamsSchema>;
export type ProtocolWelcomeResult = z.infer<typeof ProtocolWelcomeResultSchema>;
export type DaemonStatusResult = z.infer<typeof DaemonStatusResultSchema>;
export type DaemonShutdownParams = z.infer<typeof DaemonShutdownParamsSchema>;
export type DaemonDrainingEvent = z.infer<typeof DaemonDrainingEventSchema>;
export type ClientApiSessionListItem = z.infer<typeof SessionListItemSchema>;
export type SessionListSnapshotEvent = z.infer<typeof SessionListSnapshotEventSchema>;
export type SessionListUpsertEvent = z.infer<typeof SessionListUpsertEventSchema>;
export type SessionListRemoveEvent = z.infer<typeof SessionListRemoveEventSchema>;
export type SessionListResyncRequiredEvent = z.infer<typeof SessionListResyncRequiredEventSchema>;
export type SessionApprovalPolicy = z.infer<typeof SessionApprovalPolicySchema>;
export type UnixRequestFrame = z.infer<typeof UnixRequestFrameSchema>;
export type UnixResponseFrame = z.infer<typeof UnixResponseFrameSchema>;
export type UnixEventFrame = z.infer<typeof UnixEventFrameSchema>;
export type UnixFrame = z.infer<typeof UnixFrameSchema>;
