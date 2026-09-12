import type { SessionRuntime } from '../core/index.js';

export const ASSERTION_PURPOSES = [
  'workspace_list',
  'workspace_candidate_validate',
  'workspace_candidate_browse',
  'workspace_candidate_select',
  'settings_read',
  'settings_write',
  'credential_write',
  'credential_delete',
  'oauth_login',
  'oauth_select',
  'oauth_delete',
  'session_update',
  'session_list',
  'model_list',
  'session_create',
  'session_read',
  'message_submit',
  'command_invoke',
  'interaction_resolve',
  'abort',
  'events_connect',
] as const;
export type AssertionPurpose = (typeof ASSERTION_PURPOSES)[number];

export type GatewayAssertionClaims = {
  iss: string;
  aud: string;
  sub: string;
  purpose: AssertionPurpose;
  iat: number;
  nbf: number;
  exp: number;
  jti: string;
  ver: 1;
  workspaceId?: string;
  sessionId?: string;
};

export type WorkspaceAlias = {
  workspaceId: string;
  label: string;
  access: 'read' | 'read_write';
};

export type WorkspaceGrantBffRecord = {
  workspaceId: string;
  ownerUserId: string;
  label: string;
  access: 'read' | 'read_write';
};

export type WorkspaceGrant = {
  workspaceId: string;
  ownerUserId: string;
  label: string;
  kind: 'local' | 'ssh';
  localRoot?: string;
  sshTargetId?: string;
  remoteRoot?: string;
  access: 'read' | 'read_write';
  enabled: boolean;
};

export type SshTarget = {
  sshTargetId: string;
  host: string;
  port: number;
  username: string;
  remoteRootAllowlist: string[];
  knownHostsProfile: string;
  agentProfileId: string;
  enabled: boolean;
};

export type GatewayManifest = {
  version: number;
  grants: WorkspaceGrant[];
  sshTargets?: SshTarget[];
  sha256?: string;
};

export type SessionBinding = {
  sessionId: string;
  ownerUserId: string;
  workspaceId: string;
  grantVersion: number;
  canonicalRoot: string;
  access: 'read' | 'read_write';
};

export type SecretFreeWorkerSettings = {
  providerId: string;
  modelId: string;
  /** Present for the legacy fixture broker; absent for the real provider stack. */
  brokerCapabilityId?: string;
  /** Canonical real path used by both the settings snapshot and execution context. */
  executionRoot: string;
  envPolicyVersion: 1;
  reasoningEffort?: string;
  mode?: string;
  toolPolicy?: Readonly<Record<string, boolean>>;
  defaultsRevision?: string | number;
};

/** Secret-free settings captured when a gateway session is admitted. */
export type SessionSettingsSnapshot = Readonly<{
  providerId: string;
  modelId: string;
  reasoningEffort: string;
  mode: string;
  effectiveToolPolicy: Readonly<Record<string, boolean>>;
  defaultsRevision?: string | number;
}>;

export type NormalizedProviderRequest = {
  messages: readonly Record<string, unknown>[];
  tools?: readonly Record<string, unknown>[];
};
export type NormalizedProviderResponse = {
  text?: string;
  finishReason?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
};
export type NormalizedProviderChunk = {
  type: 'text' | 'reasoning' | 'tool_call' | 'usage' | 'done' | 'error';
  value?: string;
};

export type ProviderBrokerCapability = {
  capabilityId: string;
  providerId: string;
  modelId: string;
  request(input: NormalizedProviderRequest): Promise<NormalizedProviderResponse>;
  stream(input: NormalizedProviderRequest): AsyncIterable<NormalizedProviderChunk>;
};

/**
 * Audit-operation allowlist. The tuple is the single source of truth: the
 * `SafeLogOperation` union and the runtime set in `safe-log.ts` both derive
 * from it, so an operation cannot be added to one without the other.
 */
export const SAFE_LOG_OPERATIONS = [
  'startup',
  'workspace_list',
  'workspace_candidate_validate',
  'workspace_candidate_browse',
  'workspace_candidate_select',
  'settings_read',
  'settings_write',
  'credential_write',
  'credential_delete',
  'oauth_login',
  'oauth_select',
  'oauth_delete',
  'session_update',
  'session_list',
  'model_list',
  'session_create',
  'session_resume',
  'session_read',
  'message_submit',
  'command_invoke',
  'interaction_resolve',
  'abort',
  'events_connect',
  'shutdown',
] as const;
export type SafeLogOperation = (typeof SAFE_LOG_OPERATIONS)[number];

/** Audit-reason allowlist, derived and consumed the same way as the operations above. */
export const SAFE_LOG_REASONS = [
  'disabled',
  'invalid_assertion',
  'replay',
  'owner_mismatch',
  'workspace_not_found',
  'workspace_escape',
  'model_unavailable',
  'provider_unavailable',
  'shutdown',
  'forced_shutdown',
  'startup_failed',
  'accepted',
  'completed',
  'workspace_root_unavailable',
  'workspace_root_not_canonical',
  'workspace_path_escape',
  'workspace_not_readable',
  'candidate_registry_full',
  'settings_conflict',
  'settings_not_allowed',
  'not_persisted',
] as const;
export type SafeLogReason = (typeof SAFE_LOG_REASONS)[number];

export type GatewaySafeLogMetadata = {
  schemaVersion: 1;
  sessionId?: string;
  workspaceId?: string;
  grantVersion?: number;
  access?: 'read' | 'read_write';
  principalRef?: string;
  providerId?: string;
  modelId?: string;
  correlationId: string;
  operation: SafeLogOperation;
  outcome: 'allowed' | 'denied' | 'failed' | 'interrupted';
  reasonCode?: SafeLogReason;
};

export type GatewaySessionComposition = {
  sessionId: string;
  binding: SessionBinding;
  executionContext: import('../services/execution-context.js').ExecutionContext;
  settings: SecretFreeWorkerSettings;
  /** Session-owned mutable settings service; never serialized across the worker boundary. */
  sessionSettingsService?: import('../services/service-interfaces.js').ISettingsService;
  providerBroker?: ProviderBrokerCapability;
  sessionSettingsSnapshot?: SessionSettingsSnapshot;
  env: Readonly<Record<string, string>>;
  spawnOptions: {
    cwd: string;
    env: Readonly<Record<string, string>>;
    gatewayMode: true;
  };
  runtime?: SessionRuntime;
  dispose(): Promise<void> | void;
};

export const isAssertionPurpose = (value: unknown): value is AssertionPurpose =>
  typeof value === 'string' && (ASSERTION_PURPOSES as readonly string[]).includes(value);
