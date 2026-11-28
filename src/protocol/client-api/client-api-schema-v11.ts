/**
 * Additive Client API v1.1 Zod schemas (Unix binding minor bump).
 * Self-contained (depends only on `zod`) for graduation into @qduc/agent-wire (Decision D006).
 *
 * Strictness policy:
 * - C -> H request schemas use `z.strictObject(...)`.
 * - H -> C response / event schemas use `z.looseObject(...)`.
 */
import { z } from 'zod';

const PositiveInt = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const NonNegativeInt = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const UtcTimestamp = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/);
const OpaqueId = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/);
const ControlFreeString = z
  .string()
  .min(1)
  .regex(/^[^\x00-\x1F\x7F]+$/);

const SessionModelRefSchema = z.strictObject({
  provider: ControlFreeString,
  model: ControlFreeString,
});

const SessionListItemV11Schema = z.looseObject({
  id: ControlFreeString,
  workspaceId: OpaqueId,
  workspaceRoot: ControlFreeString.optional(),
  status: z.enum(['idle', 'running', 'awaiting_interaction', 'interrupted', 'closed']),
  awaitingKind: z.enum(['approval', 'question', 'budget']).optional(),
  createdAt: UtcTimestamp,
  updatedAt: UtcTimestamp,
  latestSequence: NonNegativeInt,
  title: ControlFreeString.max(120).optional(),
  model: z.looseObject({ provider: ControlFreeString, model: ControlFreeString }).optional(),
  messageCount: NonNegativeInt.optional(),
  pendingInteractionCount: NonNegativeInt.optional(),
  activeBackgroundTaskCount: NonNegativeInt.optional(),
});

const ReasoningSelectionSchema = z.enum(['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh']);
const ApprovalModeSchema = z.enum(['off', 'auto', 'unattended', 'always']);

const SessionApprovalPolicyV11Schema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('interactive') }),
  z.strictObject({ mode: z.literal('headless'), autoApprove: z.boolean() }),
]);

const LaunchSelectionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('new') }),
  z.strictObject({ kind: z.literal('resume'), sessionId: ControlFreeString }),
  z.strictObject({ kind: z.literal('fork'), sessionId: ControlFreeString }),
]);

const LaunchSshTargetSchema = z.strictObject({
  target: ControlFreeString,
  directory: ControlFreeString.optional(),
  port: PositiveInt.max(65535).optional(),
});

const LaunchGoalSchema = z.strictObject({
  text: ControlFreeString,
  successCriteria: z.string().optional(),
});

const LaunchCommonFields = {
  selection: LaunchSelectionSchema,
  model: SessionModelRefSchema.optional(),
  reasoning: ReasoningSelectionSchema.optional(),
  profileId: ControlFreeString.optional(),
  profileExplicit: z.boolean().optional(),
  approvalMode: ApprovalModeSchema.optional(),
  showReview: z.boolean().optional(),
  sandboxEnabled: z.boolean().optional(),
  requireSandbox: z.boolean().optional(),
  approvalPolicy: SessionApprovalPolicyV11Schema.optional(),
  goal: LaunchGoalSchema.optional(),
  persistSessionConfiguration: z.boolean().optional(),
  clientMode: z.enum(['interactive', 'headless', 'acp']).optional(),
} as const;

/** Owner-only local session launch (`client-api.md` §5.3, v1.1). */
const SessionLaunchParamsSchema = z.union([
  z.strictObject({ cwd: ControlFreeString, ...LaunchCommonFields }),
  z.strictObject({ workspaceId: OpaqueId, ...LaunchCommonFields }),
  z.strictObject({ ssh: LaunchSshTargetSchema, ...LaunchCommonFields }),
]);

const SessionLaunchResultSchema = z.looseObject({
  session: SessionListItemV11Schema,
  workspace: z.looseObject({
    workspaceId: OpaqueId,
    root: ControlFreeString,
    target: z.enum(['local', 'ssh']),
    sshTarget: ControlFreeString.optional(),
  }),
  profileMetadata: z.record(z.string(), z.unknown()).optional(),
  forkedFrom: ControlFreeString.optional(),
});

/** `session.list` v1.1: optional owner-local `cwd` (mutually exclusive with `workspaceId`). */
const SessionListParamsV11Schema = z.union([
  z.strictObject({
    limit: PositiveInt.max(100).optional(),
    cursor: z.string().min(1).optional(),
    workspaceId: OpaqueId.optional(),
  }),
  z.strictObject({
    limit: PositiveInt.max(100).optional(),
    cursor: z.string().min(1).optional(),
    cwd: ControlFreeString,
  }),
]);

/** `session.handoff` v1.1: optional target `model` installed on successor before admitting handoff text. */
const SessionHandoffParamsV11Schema = z.strictObject({
  sourceSessionId: ControlFreeString,
  name: ControlFreeString.optional(),
  text: z.string().optional(),
  model: SessionModelRefSchema.optional(),
});

/** Scoped `settings.get` / `settings.subscribe` v1.1 (Unix owner only). */
const SettingsGetParamsV11Schema = z.strictObject({
  sessionId: ControlFreeString.optional(),
  view: z.enum(['web', 'tui']).optional(),
});

const SettingsSubscribeParamsV11Schema = z.strictObject({
  sessionId: ControlFreeString.optional(),
  view: z.enum(['web', 'tui']).optional(),
});

const DefinedValue = z.unknown().refine((val) => val !== undefined, { message: 'value is required' });

const SettingsChangeV11Schema = z.union([
  z.strictObject({ key: ControlFreeString, value: DefinedValue }),
  z.strictObject({ key: ControlFreeString, reset: z.literal(true) }),
]);

const SettingsUpdateParamsV11Schema = z.strictObject({
  expectedRevision: ControlFreeString,
  sessionId: ControlFreeString.optional(),
  view: z.enum(['web', 'tui']).optional(),
  persist: z.boolean().optional(),
  requestId: ControlFreeString.optional(),
  changes: z.array(SettingsChangeV11Schema).min(1).max(100),
});

/** `models.list` v1.1: optional single-provider load and cache refresh. */
const ModelsListParamsV11Schema = z.strictObject({
  provider: ControlFreeString.optional(),
  refresh: z.boolean().optional(),
  sessionId: ControlFreeString.optional(),
});

/** `providers.upsert` v1.1: supports secret/endpoint retention on edits and renames. */
const ProviderUpsertParamsV11Schema = z.union([
  z.strictObject({
    action: z.literal('toggle'),
    id: ControlFreeString,
    disabled: z.boolean(),
  }),
  z.strictObject({
    action: z.literal('save').optional(),
    name: ControlFreeString,
    type: ControlFreeString,
    baseUrl: z.string().optional(),
    apiKey: z.string().optional(),
    originalId: ControlFreeString.optional(),
    keepApiKey: z.boolean().optional(),
    keepBaseUrl: z.boolean().optional(),
  }),
]);

/** `mcp.login` v1.1: optional client-handoff authorization URL mode. */
const McpLoginParamsV11Schema = z.strictObject({
  serverId: ControlFreeString,
  workspaceId: OpaqueId.optional(),
  handoffUrl: z.boolean().optional(),
});

/** Local operator `term2 serve` HTTP/BFF listener lease (`transport-unix.md` §5, capability `local_leases`). */
const DaemonServeStartParamsSchema = z.strictObject({
  stateDir: ControlFreeString,
  localOwnerUserId: ControlFreeString,
  allowWrite: z.boolean(),
  pairing: z.boolean(),
  bffKeys: z.array(z.strictObject({ kid: ControlFreeString, pemPath: ControlFreeString })),
  transport: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('socket'), socketPath: ControlFreeString }),
    z.strictObject({
      kind: z.literal('tls'),
      host: ControlFreeString,
      port: PositiveInt.max(65535),
      certPath: ControlFreeString,
      keyPath: ControlFreeString,
    }),
  ]),
});

const DaemonServeStopParamsSchema = z.strictObject({
  leaseId: OpaqueId,
});

const ServePairingOtpEventSchema = z.looseObject({
  leaseId: OpaqueId,
  code: ControlFreeString,
  expiresAt: UtcTimestamp,
});

/** Local operator named control socket binding (`transport-unix.md` §5, capability `local_leases`). */
const SessionControlBindParamsSchema = z.strictObject({
  sessionId: ControlFreeString,
  name: ControlFreeString,
  discordInput: z.boolean(),
  startup: z.boolean().optional(),
});

const SessionControlRebindParamsSchema = z.strictObject({
  leaseId: OpaqueId,
  sessionId: ControlFreeString,
});

const SessionControlUnbindParamsSchema = z.strictObject({
  leaseId: OpaqueId,
  pauseForHandoff: z.boolean().optional(),
});

/** Local ACP per-session MCP server installation (`client-api.md` §9, v1.1). */
const SessionAcpSetMcpParamsSchema = z.strictObject({
  sessionId: ControlFreeString,
  servers: z.array(z.record(z.string(), z.unknown())),
});

export const CLIENT_API_SCHEMAS_V11 = {
  sessionLaunchParams: SessionLaunchParamsSchema,
  sessionLaunchResult: SessionLaunchResultSchema,
  sessionListParamsV11: SessionListParamsV11Schema,
  sessionHandoffParamsV11: SessionHandoffParamsV11Schema,
  settingsGetParamsV11: SettingsGetParamsV11Schema,
  settingsSubscribeParamsV11: SettingsSubscribeParamsV11Schema,
  settingsUpdateParamsV11: SettingsUpdateParamsV11Schema,
  modelsListParamsV11: ModelsListParamsV11Schema,
  providerUpsertParamsV11: ProviderUpsertParamsV11Schema,
  mcpLoginParamsV11: McpLoginParamsV11Schema,
  daemonServeStartParams: DaemonServeStartParamsSchema,
  daemonServeStopParams: DaemonServeStopParamsSchema,
  servePairingOtpEvent: ServePairingOtpEventSchema,
  sessionControlBindParams: SessionControlBindParamsSchema,
  sessionControlRebindParams: SessionControlRebindParamsSchema,
  sessionControlUnbindParams: SessionControlUnbindParamsSchema,
  sessionAcpSetMcpParams: SessionAcpSetMcpParamsSchema,
} as const;

export type SessionLaunchParams = z.infer<typeof SessionLaunchParamsSchema>;
export type SessionLaunchResult = z.infer<typeof SessionLaunchResultSchema>;
export type SettingsUpdateParamsV11 = z.infer<typeof SettingsUpdateParamsV11Schema>;
export type ModelsListParamsV11 = z.infer<typeof ModelsListParamsV11Schema>;
export type ProviderUpsertParamsV11 = z.infer<typeof ProviderUpsertParamsV11Schema>;
export type DaemonServeStartParams = z.infer<typeof DaemonServeStartParamsSchema>;
export type SessionControlBindParams = z.infer<typeof SessionControlBindParamsSchema>;
