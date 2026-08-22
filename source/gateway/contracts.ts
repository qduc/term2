import type { SessionRuntime } from '../core/index.js';

export const ASSERTION_PURPOSES = [
  'workspace_list',
  'session_list',
  'model_list',
  'session_create',
  'session_read',
  'message_submit',
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
  brokerCapabilityId: string;
  /** Canonical real path used by both the settings snapshot and execution context. */
  executionRoot: string;
  envPolicyVersion: 1;
};

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
  operation:
    | 'startup'
    | 'workspace_list'
    | 'session_list'
    | 'model_list'
    | 'session_create'
    | 'session_read'
    | 'message_submit'
    | 'interaction_resolve'
    | 'abort'
    | 'events_connect'
    | 'shutdown';
  outcome: 'allowed' | 'denied' | 'failed' | 'interrupted';
  reasonCode?: string;
};

export type GatewaySessionComposition = {
  sessionId: string;
  binding: SessionBinding;
  executionContext: import('../services/execution-context.js').ExecutionContext;
  settings: SecretFreeWorkerSettings;
  providerBroker: ProviderBrokerCapability;
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
