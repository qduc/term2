/** Private HTTP transport contracts. These DTOs do not carry runtime handles or credentials into Session. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DirectHost, DirectConnection, Principal, WorkspaceGrant } from './in-process-direct-types.js';
export type { Principal } from './in-process-direct-types.js';
import type { WireCommand, WireSnapshot } from '../protocol/wire.js';

export const ASSERTION_PURPOSES = [
  'workspace_list',
  'workspace_files',
  'workspace_candidate_validate',
  'workspace_candidate_browse',
  'workspace_candidate_select',
  'workspace_ssh_hosts',
  'workspace_ssh_add',
  'workspace_remove',
  'workspace_access_update',
  'settings_read',
  'settings_write',
  'credential_write',
  'credential_delete',
  'oauth_login',
  'oauth_select',
  'oauth_delete',
  'provider_presets',
  'provider_write',
  'provider_delete',
  'skills_list',
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
  'session_rewind_targets',
  'session_rewind',
  'session_queue',
  'session_task_control',
  'session_files',
  'session_quota',
  'session_goal',
  'session_handoff',
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
export const isAssertionPurpose = (value: unknown): value is AssertionPurpose =>
  typeof value === 'string' && (ASSERTION_PURPOSES as readonly string[]).includes(value);
export type ServerResult = {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
  stream?: { start(response: ServerResponse, request: IncomingMessage): Promise<void>; close(): void };
};
export type ServerRequest = {
  claims: GatewayAssertionClaims;
  body: unknown;
  request: IncomingMessage;
  url: URL;
  correlationId?: string;
};
export type WorkspaceAlias = {
  workspaceId: string;
  label: string;
  access: 'read' | 'read_write';
  kind?: 'directory' | 'host' | 'ssh';
};
export type WorkspaceCheck = {
  name: 'absolute' | 'exists' | 'directory' | 'readable' | 'canonical';
  status: 'ok' | 'error' | 'pending';
};
export type CandidateValidation =
  | { valid: true; candidateId: string; displayName: string; expiresAt: number; checks: readonly WorkspaceCheck[] }
  | { valid: false; checks: readonly WorkspaceCheck[]; reasonCode: string; reason: string };
export type CandidateBrowse = {
  candidateId: string;
  entries: readonly {
    name: string;
    type: 'directory' | 'file' | 'symlink' | 'other';
    selectable: boolean;
    rejectionReason?: string;
    targetDisplay?: string;
    childToken?: string;
  }[];
  truncated: boolean;
};
export type CandidateSelection = {
  workspaceId: string;
  displayName: string;
  binding: {
    sessionId: string;
    ownerUserId: string;
    workspaceId: string;
    grantVersion: number;
    canonicalRoot: string;
    access: 'read' | 'read_write';
  };
};
/** The same admission authority must back resolveGrant and DirectHost.resolveWorkspace.
 * It validates owner/enabled/access/canonical containment before creation; never trust a body path.
 */
export interface ServerWorkspaces {
  list(principal: Principal): readonly WorkspaceAlias[] | Promise<readonly WorkspaceAlias[]>;
  listFiles?(
    principal: Principal,
    workspaceId: string,
  ): Promise<{ entries: readonly WorkspaceFileEntry[]; truncated: boolean }>;
  resolveGrant(principal: Principal, workspaceId: string): WorkspaceGrant | Promise<WorkspaceGrant>;
  validate?(principal: Principal, absolutePath: string): CandidateValidation | Promise<CandidateValidation>;
  browse?(principal: Principal, candidateId: string, child?: string): CandidateBrowse | Promise<CandidateBrowse>;
  select?(
    principal: Principal,
    candidateId: string,
    access: 'read' | 'read_write',
  ): CandidateSelection | Promise<CandidateSelection>;
  /** Owner's dynamic grant only. Live sessions under it must be closed before this resolves. */
  remove?(principal: Principal, workspaceId: string): WorkspaceRemoval | Promise<WorkspaceRemoval>;
  /** Owner's dynamic grant only; widening obeys the server's write permission. Live sessions are closed. */
  changeAccess?(
    principal: Principal,
    workspaceId: string,
    access: 'read' | 'read_write',
  ): WorkspaceAccessChange | Promise<WorkspaceAccessChange>;
  listSshHosts?(
    principal: Principal,
  ): Promise<
    readonly { readonly alias: string; readonly hostName?: string; readonly user?: string; readonly port?: number }[]
  >;
  addSsh?(
    principal: Principal,
    input: {
      readonly target: string;
      readonly port?: number;
      readonly directory?: string;
      readonly access: 'read' | 'read_write';
    },
  ): Promise<WorkspaceAlias>;
}
export type WorkspaceRemoval = { workspaceId: string; removed: true; closedSessions: number };
export type WorkspaceAccessChange = { workspace: WorkspaceAlias; grantVersion: number; closedSessions: number };
/** USD per million tokens, from term2's vendored model catalog. Absent prices are unknown, not free. */
export type ModelPrices = {
  inputPerMTok?: number;
  outputPerMTok?: number;
  cacheReadPerMTok?: number;
  cacheWritePerMTok?: number;
};
export type ModelCatalogEntry = {
  provider: string;
  id: string;
  name?: string;
  default_reasoning_level?: string;
  contextWindow?: number;
  /** Largest output the model produces in one response, when the catalog knows it. */
  maxOutputTokens?: number;
  /** Base prices, plus higher tiers that apply once a request's input exceeds `inputTokensAbove`. */
  pricing?: ModelPrices & { tiers?: (ModelPrices & { inputTokensAbove: number })[] };
};
/** Value shapes defined by the web settings policy (`config/settings/web-settings-policy.ts`). */
export type SafeSettingValue = import('../config/settings/web-settings-policy.js').WebSettingValue;
export type ProviderPresetEntry = {
  id: string;
  name: string;
  category: string;
  docsUrl: string;
  builtinProviderId?: string;
  type?: string;
  baseUrl?: string;
};
export type ProviderWriteInput =
  | { action: 'toggle'; id: string; disabled: boolean }
  | {
      action: 'save';
      originalId?: string | null;
      name: string;
      type: string;
      baseUrl?: string;
      apiKey?: string;
    };
export type SkillSummary = { name: string; description: string; isProjectLevel: boolean };
export type WorkspaceFileEntry = { path: string; type: 'file' | 'directory' };
export type SettingsProjection = {
  schemaVersion: 1;
  revision: string;
  defaultsRevision: string;
  settings: {
    safeDefaults: Record<
      string,
      {
        value?: SafeSettingValue;
        source: string;
        scope: 'global' | 'session';
        confirmRequired: boolean;
        persistable: boolean;
      }
    >;
    credentials: Record<string, { configured: boolean; required: boolean; source: string; writable: boolean }>;
    providers: readonly {
      id: string;
      label: string;
      isCustom: boolean;
      active: boolean;
      disabled: boolean;
      credential: { configured: boolean; required: boolean; source: string; writable: boolean };
    }[];
    oauthAccounts: Record<string, readonly { id: string; label: string; isSelected: boolean; isInUse: boolean }[]>;
    safety: {
      sandbox: 'enabled' | 'disabled' | 'unavailable';
      showReview: boolean;
      approval: 'off' | 'auto' | 'unattended' | 'unsafe-active' | 'hidden';
      backgroundShell: 'enabled' | 'disabled-by-gateway';
      workspaceAccess: 'read' | 'read_write';
      network: 'denied' | 'configured' | 'confirmation-required';
    };
  };
  /** Display-only machine fact. Absent when the shell sandbox can run. Not an approval decision. */
  shellSandboxNotice?: ShellSandboxNotice;
  /** Runtime capabilities advertised by this server instance so web-client hides unsupported controls. */
  capabilities?: ServerCapabilities;
};
export type ServerTaskAction = 'cancel' | 'background' | 'check_in' | 'foreground';
export type ServerCapabilities = {
  readonly sessionBrowser: boolean;
  readonly rollover: boolean;
  readonly backgroundShell: boolean;
  readonly goalsWrite: boolean;
  readonly approvalReviewTakeover: boolean;
  readonly taskActions: readonly ServerTaskAction[];
};
export type ShellSandboxNotice = {
  code: string;
  detail: string;
};
/** App-owned global configuration authority. Implementations must redact secrets in all results,
 * enforce the settings allowlist/revision transaction and persist before reporting committed.
 * The server serializes global settings/credential mutations and OAuth mutations separately.
 */
export interface ServerConfiguration {
  read?(): SettingsProjection | Promise<SettingsProjection>;
  write?(
    expectedRevision: string,
    changes: readonly { key: string; value: SafeSettingValue }[],
  ): Promise<SettingsProjection>;
  setCredential?(id: string, value: string): Promise<{ status: 'saved'; configured: boolean; source: string }>;
  deleteCredential?(
    id: string,
  ): Promise<{ status: 'deleted' | 'unchanged'; configured: boolean; source?: 'environment' }>;
  oauthLogin?(
    provider: 'codex' | 'grok',
  ): Promise<{ status: 'completed'; configured: boolean } | { status: 'not_completed' }>;
  oauthSelect?(
    provider: 'codex' | 'grok',
    accountId: string,
  ): Promise<{ ok: boolean; isSelected: boolean; isInUse: boolean }>;
  oauthDelete?(provider: 'codex' | 'grok', accountId: string): Promise<{ ok: boolean }>;
  listProviderPresets?():
    | { presets: readonly ProviderPresetEntry[]; types: readonly string[] }
    | Promise<{ presets: readonly ProviderPresetEntry[]; types: readonly string[] }>;
  writeProvider?(
    input: ProviderWriteInput,
  ): Promise<{ ok: boolean; error?: string; fieldErrors?: Record<string, string> }>;
  deleteProvider?(id: string): Promise<{ ok: boolean }>;
}
export type SessionMetadata = {
  workspaceId: string;
  createdAt: string;
  updatedAt: string;
  /** null until the direct durable store exposes this boundary. */
  earliestReplayableSequence: number | null;
};
export type SessionApprovalMode = 'off' | 'auto' | 'unattended' | 'always';
export type SessionConfiguration = {
  sessionId: string;
  providerId: string;
  modelId: string;
  reasoningEffort: string;
  mode: string;
  approvalMode?: SessionApprovalMode;
  toolPolicy: { allowWrite: boolean; autoApprove: boolean; allowUnsandboxed: boolean; sshEnabled: boolean };
  configRevision: string;
  defaultsRevision: string | number;
};
/** App-owned presentation and pure configuration intent preparation; no server settings writer. */
export interface ServerSessionPresentation {
  metadata(principal: Principal, snapshot: WireSnapshot): SessionMetadata | Promise<SessionMetadata>;
  configuration?(principal: Principal, snapshot: WireSnapshot): SessionConfiguration | Promise<SessionConfiguration>;
  listFiles?(
    principal: Principal,
    snapshot: WireSnapshot,
  ): Promise<{ entries: readonly WorkspaceFileEntry[]; truncated: boolean }>;
  prepareSkillText?(
    principal: Principal,
    snapshot: WireSnapshot,
    skillName: string,
    text: string,
  ): Promise<string | null> | string | null;
  /** Scope session-local approval mode to Session's atomic configure pipeline without pre-acceptance mutation. */
  withApprovalMode?<Result>(
    principal: Principal,
    snapshot: WireSnapshot,
    approvalMode: SessionApprovalMode,
    operation: () => Promise<Result>,
  ): Promise<Result>;
  /** Authorize the supplied logical snapshot cut and prepare the whole requested patch.
   * No effects, generated invocation key, current-revision substitution or partial application. */
  prepareConfiguration?(
    principal: Principal,
    snapshot: WireSnapshot,
    body: unknown,
  ): Extract<WireCommand, { readonly type: 'configure' }> & {
    readonly admission: 'idle';
    readonly expectedRevision: string;
  };
  /** Set, update status, clear, or accept a proposed durable goal for this session. */
  setGoal?(principal: Principal, snapshot: WireSnapshot, action: ServerGoalAction): Promise<void>;
  /** Hand off the latest assistant response to a fresh successor session. */
  handoff?(
    principal: Principal,
    snapshot: WireSnapshot,
    input: ServerHandoffInput,
  ): Promise<{ readonly sessionId: string }>;
}
export type ServerHandoffInput = {
  readonly message?: string;
  readonly model?: { readonly provider: string; readonly model: string };
};
export type ServerGoalAction =
  | { readonly action: 'set'; readonly text: string; readonly successCriteria?: string }
  | { readonly action: 'achieved' | 'abandon' | 'clear' | 'accept_proposal' };
export type ServerAudit = {
  operation: AssertionPurpose;
  principal: Principal;
  outcome: 'allowed' | 'denied' | 'failed';
  sessionId?: string;
  correlationId?: string;
};
export type ServerHostDependencies = {
  host: DirectHost;
  workspaces?: ServerWorkspaces;
  models?(): readonly ModelCatalogEntry[] | Promise<readonly ModelCatalogEntry[]>;
  skills?(principal: Principal, workspaceId?: string): readonly SkillSummary[] | Promise<readonly SkillSummary[]>;
  configuration?: ServerConfiguration;
  presentation?: ServerSessionPresentation;
  localOwnerUserId?: string;
  /** Receives only safe metadata, never request bodies, credentials, tokens or paths. */
  audit?(event: ServerAudit): void | Promise<void>;
};
export type ServerTransportOptions =
  | { socketPath: string; host?: never; port?: never; tls?: never }
  | {
      socketPath?: never;
      host?: string;
      port: number;
      tls: {
        certPath: string;
        keyPath: string;
        caPath?: string;
        requireClientCert: boolean;
      };
    };
export type ServerSessionRequest = {
  claims: GatewayAssertionClaims;
  principal: Principal;
  body: unknown;
  connection: DirectConnection;
  url: URL;
  request: IncomingMessage;
  interactionId?: string;
};
/** Only {} is discovery; a mutation requires the caller key and native revision. */
export type SessionUpdateBody = {
  clientRequestId?: string;
  expectedRevision?: string;
  admission?: 'idle';
  modelSelection?: { model: string; provider: string };
  reasoningEffort?: 'default' | 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  mode?: 'standard' | 'bare' | 'lite';
  approvalMode?: SessionApprovalMode;
};
export type CommandBody = {
  commandId: string;
  clientRequestId: string;
  admission?: 'idle';
  expectedRevision?: string;
  executionId?: string;
};
export type InteractionResolveBody = {
  revision: number;
  answer: string;
  rejectionReason?: string;
  approvalAnswer?: string;
};
