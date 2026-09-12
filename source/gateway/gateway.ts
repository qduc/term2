import crypto from 'node:crypto';
import { createGatewayAssertion } from './assertion.js';
import { GatewayLifecycle } from './lifecycle.js';
import {
  loadGatewayManifest,
  WorkspaceAdmission,
  WorkspaceAdmissionError,
  type WorkspaceBoundaryProbe,
} from './workspace-admission.js';
import {
  assertProviderBrokerReady,
  composeGatewaySession,
  type GatewaySessionCompositionOptions,
  type WorkerBoundaryProbe,
} from './worker-boundary.js';
import type {
  GatewayAssertionClaims,
  GatewayManifest,
  GatewaySafeLogMetadata,
  ProviderBrokerCapability,
  SessionBinding,
  SessionSettingsSnapshot,
} from './contracts.js';
import { createSafeLogMetadata, GatewayAuditLog } from './safe-log.js';
import { AssertionVerifier } from './assertion.js';
import { SqliteReplayLedger } from './replay-ledger.js';
import { GatewayServer } from './server.js';
import { RuntimeFactoryError, type RuntimeFactory } from './runtime-factory.js';
import type { ConversationEvent } from '../services/conversation/conversation-events.js';
import { projectConversationMessage } from '../services/conversation/conversation-message-projection.js';
import { normalizeRunItem } from '../services/conversation/run-item-normalizer.js';
import type { LogEvent } from '../services/logging/conversation-log-events.js';
import {
  FROZEN_AGENT_EVENT_TYPES,
  GatewayPersistenceError,
  TERMINAL_AGENT_EVENT_TYPES,
  type AgentEventType,
  type GatewaySessionRecord,
} from './persistence/contracts.js';
import {
  createSessionProjectionSource,
  hydrateConversationService,
  type PendingInteractionDto,
  type ProjectionCommand,
  type SessionProjectionSource,
} from './persistence/projection.js';
import {
  decideInteraction,
  InteractionProtocolError,
  projectPendingInteraction,
  validatePendingInteractionDto,
  type PendingInteractionDto as InteractionDto,
} from './interaction-protocol.js';
import { GatewayAdmissionPersistence, normalizedBodyHash } from './persistence/admission-persistence.js';
import {
  GATEWAY_EVENT_HEARTBEAT_INTERVAL_MS,
  GATEWAY_EVENT_STREAM_CONTENT_TYPE,
  GATEWAY_EVENT_STREAM_HEARTBEAT,
  type GatewayRpcResult,
  type GatewayTlsOptions,
} from './server.js';
import { ServerSession } from './server-session.js';
import { createSessionSettingsSnapshot } from './launcher-seam.js';
import { readSessionSnapshot, writeSessionSnapshot } from './persistence/session-snapshot.js';
import type { GatewayPersistenceCoordinator, GatewayPersistedSession } from './persistence/coordinator.js';
import { ServerSessionError } from './server-session.js';
import { DynamicWorkspaceRegistry, DynamicWorkspaceRegistryError } from './dynamic-workspace-registry.js';
import { accessSync, constants as fsConstants, realpathSync, statSync } from 'node:fs';
import { ModelCatalogSession } from '../services/models/model-catalog-session.js';
import { getAvailableProviderIds } from '../utils/ai/provider-credentials.js';
import { getProviderIds } from '../providers/index.js';
import { LoggingService } from '../services/logging/logging-service.js';
import {
  applySettingsChanges,
  buildSettingsProjection,
  deleteCredential,
  setCredential,
  SettingsRpcError,
  type SettingsAuthority,
} from './settings-rpc.js';
import { GatewayPairing, PairingError } from './pairing.js';
import { TrustedClientsStore } from './trusted-clients.js';
import {
  isOAuthAccountProvider,
  listOAuthAccounts,
  removeOAuthAccount,
  setActiveOAuthAccount,
  type OAuthAccountProviderId,
} from '../providers/oauth-accounts.js';
import { loginToCodex } from '../providers/codex-auth.js';
import { loginToGrok } from '../providers/grok-auth.js';

const MAX_BUFFERED_SSE_EVENTS = 256;
const NONCRITICAL_RUNTIME_EVENT_TYPES = new Set<ConversationEvent['type']>(['text_delta', 'reasoning_delta']);
let malformedCommandMessageDrops = 0;

const isCriticalRuntimeEvent = (event: ConversationEvent): boolean => !NONCRITICAL_RUNTIME_EVENT_TYPES.has(event.type);

/**
 * `retry-turn` replays the canonical transcript verbatim, so a retry is only
 * meaningful while that transcript still ends on the user message of a turn
 * that never produced output. Assistant output or a tool result after the last
 * genuine user message means the turn committed something; synthetic user
 * items (shell context, mode notices, local summaries) are not turns.
 */
const hasFailedTurnToRetry = (history: readonly unknown[]): boolean => {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const item = history[index];
    if (normalizeRunItem(item).some((normalized) => normalized.type === 'tool_result')) return false;
    const message = projectConversationMessage(item);
    if (!message || message.isSynthetic) continue;
    if (message.role === 'user') return true;
    if (message.role === 'assistant') return false;
  }
  return false;
};

const INTERACTION_METRICS = [
  'interaction_presented',
  'interaction_updated',
  'interaction_resolved',
  'interaction_stale',
  'interaction_duplicate',
  'interaction_sanitization_rejected',
  'interaction_continuation_failed',
] as const;
type InteractionMetric = (typeof INTERACTION_METRICS)[number];
const PUBLIC_EVENT_PAYLOAD_KEYS = new Set([
  'turnId',
  'clientRequestId',
  'messageId',
  'delta',
  'callId',
  'toolName',
  'message',
  'interaction',
  'interactionId',
  'outcome',
  'reason',
  'variant',
  'revision',
  'text',
  'usage',
  'inputTokens',
  'outputTokens',
  'totalTokens',
  'version',
  'kind',
  'descriptor',
  'choices',
  'askUser',
  'questions',
  'answers',
  'currentQuestionIndex',
  'index',
  'question',
  'options',
  'multiSelect',
  'label',
  'description',
  'destructive',
  'id',
  'role',
  'agentName',
  'argumentsText',
  'checkIn',
  'display',
  'target',
  'scope',
  'warning',
  'displayPath',
  'displayParent',
  'sensitive',
  'llmAdvisory',
  'reasoning',
  'approved',
  'model',
  'riskLevel',
  'deniedRead',
  'runBudgetEvidence',
  'agentId',
  'name',
  'task',
  'async',
  'toolCallId',
  'commandMessages',
  'status',
  'output',
  'error',
  'finalText',
  'finalTextTruncated',
  'toolsUsed',
  'count',
  'terminalCause',
  'provider',
  'attempt',
  'maxRetries',
  'errorMessage',
  'retryType',
  'errorKind',
  'delayMs',
  'retryAfterMs',
  'attempts',
  'maxAttempts',
  'canRetry',
  'sessionId',
  'inputTokensBefore',
  'inputTokensAfter',
  'durationMs',
  'strategy',
  'errorCategory',
]);

const LOCAL_OWNER_PURPOSES = new Set<GatewayAssertionClaims['purpose']>([
  'settings_read',
  'settings_write',
  'credential_write',
  'credential_delete',
  'oauth_login',
  'oauth_select',
  'oauth_delete',
]);

export type GatewayLaunchConfig = {
  enabled: boolean;
  socketPath?: string;
  /** Defaults to loopback; public-interface binds are outside deployment policy. */
  host?: string;
  port?: number;
  tls?: GatewayTlsOptions;
  manifestPath: string;
  manifestSha256?: string;
  replayDbPath: string;
  issuer: string;
  audience: string;
  publicKeys: ReadonlyMap<string, string | Buffer> | Record<string, string | Buffer>;
  providerBroker?: ProviderBrokerCapability;
  providerProbe?: WorkerBoundaryProbe;
  workerSandboxAvailable?: boolean;
  workspaceBoundaryProbe?: WorkspaceBoundaryProbe;
  tmpDir?: string;
  sshEnabled?: boolean;
  allowWrite?: boolean;
  autoApprove?: boolean;
  allowUnsandboxed?: boolean;
  auditWriter?: (record: GatewaySafeLogMetadata) => Promise<void>;
  /** Required for production admission; retained optional for legacy control-plane fixtures. */
  runtimeFactory?: RuntimeFactory;
  /** Optional plan-03 durable index/log/journal owner. */
  persistence?: GatewayPersistenceCoordinator;
  /** Optional pre-wired registry; otherwise one is derived from local grants. */
  workspaceRegistry?: DynamicWorkspaceRegistry;
  /** Explicit local roots allowed to the browser-owned candidate registry. */
  workspaceAllowedRoots?: readonly string[];
  /** Test/launcher seam for the server-owned OAuth loopback flow. */
  oauthLogin?: (provider: OAuthAccountProviderId) => Promise<void>;
  /** Principal permitted to operate the process-wide settings/account stores. */
  localOwnerUserId?: string;
  pairing?: {
    enabled: boolean;
    otpTtlMs?: number;
    maxAttempts?: number;
    /** Remove this file and restart to revoke all peers and re-bootstrap pairing. */
    trustFilePath: string;
    /** Defaults to stdout; a daemon launcher prints the OTP to stderr instead. */
    printOtp?: (otp: string) => void;
  };
};

export class GatewayStartupError extends Error {
  constructor() {
    super('gateway prerequisites unavailable');
    this.name = 'GatewayStartupError';
  }
}

export function assertGatewayStartup(config: GatewayLaunchConfig, manifest?: GatewayManifest): GatewayManifest {
  const socketTransport = config.socketPath !== undefined;
  const networkTransport = config.host !== undefined || config.port !== undefined || config.tls !== undefined;
  if (socketTransport === networkTransport) throw new GatewayStartupError();
  if (socketTransport) {
    if (!config.socketPath!.startsWith('/')) throw new GatewayStartupError();
  } else {
    if (
      (config.host !== undefined && !config.host.trim()) ||
      !Number.isSafeInteger(config.port) ||
      config.port! < 1 ||
      config.port! > 65_535 ||
      !config.tls ||
      !config.tls.certPath ||
      !config.tls.keyPath ||
      (config.tls.caPath !== undefined && !config.tls.caPath) ||
      typeof config.tls.requireClientCert !== 'boolean'
    )
      throw new GatewayStartupError();
    for (const filePath of [
      config.tls.certPath,
      config.tls.keyPath,
      ...(config.tls.caPath ? [config.tls.caPath] : []),
    ]) {
      try {
        accessSync(filePath, fsConstants.R_OK);
      } catch {
        throw new GatewayStartupError();
      }
    }
  }
  if (!config.issuer || !config.audience || !config.replayDbPath) throw new GatewayStartupError();
  if (config.pairing?.enabled) {
    if (!config.pairing.trustFilePath.startsWith('/') || config.pairing.trustFilePath.includes('\u0000'))
      throw new GatewayStartupError();
    if (
      (config.pairing.otpTtlMs !== undefined &&
        (!Number.isSafeInteger(config.pairing.otpTtlMs) || config.pairing.otpTtlMs <= 0)) ||
      (config.pairing.maxAttempts !== undefined &&
        (!Number.isSafeInteger(config.pairing.maxAttempts) || config.pairing.maxAttempts <= 0))
    )
      throw new GatewayStartupError();
  }
  const configuredKeyCount =
    config.publicKeys instanceof Map ? config.publicKeys.size : Object.keys(config.publicKeys ?? {}).length;
  if (configuredKeyCount === 0 && !config.pairing?.enabled) throw new GatewayStartupError();
  if (!manifest) throw new GatewayStartupError();
  if (!config.manifestSha256 || !/^[a-f0-9]{64}$/i.test(config.manifestSha256)) throw new GatewayStartupError();
  const realProviderStack = config.runtimeFactory?.usesRealProviderStack === true;
  if (
    !realProviderStack &&
    (!config.providerBroker || !config.providerProbe?.available || !config.providerProbe.secretFree)
  )
    throw new GatewayStartupError();
  if (realProviderStack && !config.runtimeFactory?.settingsAuthority) throw new GatewayStartupError();
  if (config.workerSandboxAvailable !== true || typeof config.workspaceBoundaryProbe !== 'function')
    throw new GatewayStartupError();
  if (config.sshEnabled || config.autoApprove || config.allowUnsandboxed) throw new GatewayStartupError();
  if (typeof config.auditWriter !== 'function') throw new GatewayStartupError();
  if (!realProviderStack) assertProviderBrokerReady(config.providerBroker, config.providerProbe);
  if (!config.tmpDir?.startsWith('/')) throw new GatewayStartupError();
  return manifest;
}

/** Gateway control plane. Runtime/session protocols remain private RPC consumers. */
export class Term2Gateway {
  readonly #config: GatewayLaunchConfig;
  readonly #replay: SqliteReplayLedger;
  readonly #admission: WorkspaceAdmission;
  readonly #verifier: AssertionVerifier;
  readonly #lifecycle = new GatewayLifecycle();
  readonly #audit: GatewayAuditLog;
  readonly #sessions = new Map<string, ReturnType<typeof composeGatewaySession> | ServerSession>();
  readonly #persisted = new Map<string, GatewayPersistedSession>();
  readonly #admissions: GatewayAdmissionPersistence | null;
  readonly #interactionBindings = new Map<string, InteractionBinding>();
  readonly #childTurnIds = new Map<string, string>();
  readonly #childRoles = new Map<string, string>();
  readonly #lastTurnIds = new Map<string, string>();
  readonly #interactionCounters = new Map<InteractionMetric, number>();
  readonly #eventPersistenceTails = new Map<string, Promise<void>>();
  readonly #inflightCommands = new Map<string, { promise: Promise<GatewayRpcResult>; bodyHash: string }>();
  // Keyed by owner and session: an in-flight revival belongs to the owner who
  // started it, and no other caller may inherit its result.
  readonly #sessionRestores = new Map<
    string,
    Promise<{ session: ServerSession; persisted: GatewayPersistedSession } | GatewayRpcResult | null>
  >();
  #shutdownInProgress = false;
  #shutdownPromise?: Promise<void>;
  readonly #server: GatewayServer;
  readonly #modelCatalog?: ModelCatalogSession;
  readonly #workspaceRegistry: DynamicWorkspaceRegistry;
  readonly #pairing?: GatewayPairing;
  #oauthMutation: Promise<void> = Promise.resolve();
  #settingsMutation: Promise<void> = Promise.resolve();

  private constructor(config: GatewayLaunchConfig, manifest: GatewayManifest) {
    this.#config = config;
    this.#replay = new SqliteReplayLedger(config.replayDbPath);
    this.#admission =
      config.workspaceRegistry?.admission ??
      new WorkspaceAdmission(manifest, {
        allowWrite: config.allowWrite === true,
        boundaryProbe: config.workspaceBoundaryProbe,
      });
    this.#workspaceRegistry =
      config.workspaceRegistry ??
      new DynamicWorkspaceRegistry({
        admission: this.#admission,
        allowedRoots: config.workspaceAllowedRoots ?? deriveDynamicWorkspaceRoots(manifest),
      });
    const trustedStore = config.pairing?.enabled ? new TrustedClientsStore(config.pairing.trustFilePath) : undefined;
    const assertionKeys = new Map<string, string | Buffer>();
    for (const [kid, key] of config.publicKeys instanceof Map
      ? config.publicKeys.entries()
      : Object.entries(config.publicKeys))
      assertionKeys.set(kid, key);
    for (const trusted of trustedStore?.entries() ?? []) assertionKeys.set(trusted.kid, trusted.publicKeyPem);
    this.#verifier = new AssertionVerifier({
      issuer: config.issuer,
      audience: config.audience,
      publicKeys: assertionKeys,
      allowEmptyKeys: config.pairing?.enabled === true,
      replayLedger: this.#replay,
    });
    this.#pairing = trustedStore
      ? new GatewayPairing({
          enabled: config.pairing!.enabled,
          otpTtlMs: config.pairing!.otpTtlMs,
          maxAttempts: config.pairing!.maxAttempts,
          trustStore: trustedStore,
          ...(config.pairing!.printOtp ? { printOtp: config.pairing!.printOtp } : {}),
        })
      : undefined;
    this.#audit = new GatewayAuditLog(config.auditWriter!);
    this.#admissions = config.persistence ? new GatewayAdmissionPersistence(config.persistence.index) : null;
    const settingsAuthority = config.runtimeFactory?.settingsAuthority;
    if (settingsAuthority) {
      this.#modelCatalog = new ModelCatalogSession({
        settingsService: settingsAuthority,
        loggingService:
          config.runtimeFactory?.modelCatalogLogger ??
          new LoggingService({ disableLogging: true, suppressConsoleOutput: true }),
      });
    }
    const transport = config.socketPath
      ? { socketPath: config.socketPath }
      : { host: config.host, port: config.port!, tls: config.tls! };
    this.#server = new GatewayServer({
      ...transport,
      verifier: this.#verifier,
      lifecycle: this.#lifecycle,
      ...(this.#pairing
        ? {
            pairingHandler: async ({ body }) => {
              if (!isPairingRegisterBody(body))
                return publicError(401, 'pairing_invalid', 'pairing request is invalid');
              try {
                const result = await this.#pairing!.register(body.publicKeyPem, body.otp);
                const publicKeyPem = trustedStore!.entries().find((entry) => entry.kid === result.kid)?.publicKeyPem;
                if (!publicKeyPem) return publicError(503, 'pairing_unavailable', 'pairing is unavailable', true);
                this.#verifier.addTrustedKey(result.kid, publicKeyPem);
                return { status: 200, body: result };
              } catch (error) {
                if (error instanceof PairingError) {
                  if (error.code === 'pairing_unavailable')
                    return publicError(503, 'pairing_unavailable', 'pairing is unavailable', true);
                  return publicError(
                    401,
                    error.code === 'pairing_required' || error.code === 'pairing_not_allowed'
                      ? 'pairing_required'
                      : 'pairing_invalid',
                    'pairing rejected',
                  );
                }
                throw error;
              }
            },
          }
        : {}),
      handler: (input) => this.#handleRpc(input),
    });
  }

  async #handleRpc(input: {
    claims: GatewayAssertionClaims;
    body: unknown;
    request: import('node:http').IncomingMessage;
    url: URL;
    correlationId?: string;
  }): Promise<GatewayRpcResult> {
    const { claims, url } = input;
    const route = matchPrivateRoute(input.request.method ?? 'GET', url.pathname);
    if (!route || (route.legacy && claims.purpose !== 'session_create')) {
      return publicError(404, 'not_found', 'gateway route not found');
    }
    if (!route.legacy && route.sessionId && route.sessionId !== claims.sessionId)
      return publicError(400, 'protocol_conflict', 'gateway path and assertion session do not match');
    if (!route.legacy && route.purpose !== claims.purpose)
      return publicError(400, 'protocol_conflict', 'gateway purpose does not match route');
    if (LOCAL_OWNER_PURPOSES.has(claims.purpose) && claims.sub !== this.#config.localOwnerUserId)
      return publicError(403, 'settings_forbidden', 'local owner authorization is required');
    try {
      if (claims.purpose === 'workspace_list') {
        await this.#audit.write(
          createSafeLogMetadata({
            operation: 'workspace_list',
            outcome: 'allowed',
            reasonCode: 'accepted',
            ...(input.correlationId ? { correlationId: input.correlationId } : {}),
          }),
        );
        const limit = parseQueryLimit(url.searchParams.get('limit')) ?? 20;
        if (limit < 1 || limit > 50 || url.searchParams.get('cursor') !== null)
          return publicError(400, 'invalid_cursor', 'workspace cursor is invalid');
        return {
          status: 200,
          body: { workspaces: this.#admission.listAliases(claims.sub).slice(0, limit), nextCursor: null },
        };
      }
      if (claims.purpose === 'session_create') {
        if (hasDeferredModelSelectionField(input.body))
          return publicError(422, 'model_selection_deferred', 'Model selection is not available');
        if (!isSessionCreateBody(input.body, claims.workspaceId, route.legacy))
          return publicError(400, 'validation_error', 'session request is invalid');
        const session = await this.createSession(claims, undefined, input.correlationId);
        if (this.#config.persistence) {
          const projection = await this.#projectionFor(claims.sub, session.sessionId);
          return { status: 201, body: { session: toSessionProjection(projection) } };
        }
        return {
          status: 201,
          body: { sessionId: session.sessionId, workspaceId: session.binding.workspaceId, accepted: true },
        };
      }
      if (claims.purpose === 'session_list') {
        if (!this.#config.persistence)
          return publicError(503, 'gateway_unavailable', 'gateway persistence unavailable', true);
        const limit = parseQueryLimit(url.searchParams.get('limit'));
        const cursor = url.searchParams.get('cursor') ?? undefined;
        try {
          return { status: 200, body: this.#config.persistence.index.list(claims.sub, { limit, cursor }) };
        } catch (error) {
          if (error instanceof GatewayPersistenceError && error.code === 'cursor_invalid')
            return publicError(400, 'invalid_cursor', 'session cursor is invalid');
          throw error;
        }
      }
      if (claims.purpose === 'model_list') return await this.#modelList(input.correlationId);
      if (claims.purpose === 'workspace_candidate_validate')
        return await this.#workspaceCandidateValidate(claims, input.body, input.correlationId);
      if (claims.purpose === 'workspace_candidate_browse')
        return await this.#workspaceCandidateBrowse(claims, input.body, input.correlationId);
      if (claims.purpose === 'workspace_candidate_select')
        return await this.#workspaceCandidateSelect(claims, input.body, input.correlationId);
      if (claims.purpose === 'settings_read') return await this.#settingsRead(input.correlationId);
      if (claims.purpose === 'settings_write') return await this.#settingsWrite(input.body, input.correlationId);
      if (claims.purpose === 'credential_write')
        return await this.#credentialWrite(route.interactionId!, input.body, input.correlationId);
      if (claims.purpose === 'credential_delete')
        return await this.#credentialDelete(route.interactionId!, input.correlationId);
      if (claims.purpose === 'oauth_login') return await this.#oauthLogin(route.interactionId!, input.correlationId);
      if (claims.purpose === 'oauth_select')
        return await this.#oauthSelect(route.interactionId!, input.body, input.correlationId);
      if (claims.purpose === 'oauth_delete') return await this.#oauthDelete(route.interactionId!, input.correlationId);
      if (!claims.sessionId) return publicError(400, 'protocol_conflict', 'session assertion is incomplete');
      if (claims.purpose === 'session_update')
        return await this.#sessionUpdate(claims, input.body, input.correlationId);
      if (claims.purpose === 'session_read') {
        const projection = await this.#projectionFor(claims.sub, claims.sessionId);
        return { status: 200, body: { session: toSessionProjection(projection) } };
      }
      if (claims.purpose === 'message_submit') return await this.#submitMessage(claims, input.body);
      if (claims.purpose === 'abort') return await this.#abortSession(claims, input.body);
      if (claims.purpose === 'command_invoke')
        return await this.#invokeCommand(claims, input.body, input.correlationId);
      if (claims.purpose === 'interaction_resolve')
        return await this.#resolveInteraction(claims, route.interactionId!, input.body);
      if (claims.purpose === 'events_connect') return await this.#eventsResponse(claims, url, input.request);
      return publicError(403, 'gateway_unavailable', 'gateway operation is unavailable');
    } catch (error) {
      return this.#mapError(error);
    }
  }

  async #modelList(correlationId?: string): Promise<GatewayRpcResult> {
    const catalog = this.#modelCatalog;
    const settings = this.#config.runtimeFactory?.settingsAuthority;
    if (!catalog || !settings) return publicError(503, 'model_catalog_unavailable', 'model catalog unavailable', true);
    await this.#audit.write(
      createSafeLogMetadata({
        operation: 'model_list',
        outcome: 'allowed',
        reasonCode: 'accepted',
        ...(correlationId ? { correlationId } : {}),
      }),
    );
    const models: Array<{
      provider: string;
      id: string;
      name?: string;
      default_reasoning_level?: string;
      contextWindow?: number;
    }> = [];
    for (const provider of getAvailableProviderIds(settings, getProviderIds())) {
      try {
        const result = await catalog.load(provider);
        for (const model of result.models) {
          models.push({
            provider,
            id: model.id,
            ...(model.name === undefined ? {} : { name: model.name }),
            ...(model.default_reasoning_level === undefined
              ? {}
              : { default_reasoning_level: model.default_reasoning_level }),
            ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
          });
        }
      } catch {
        // Provider errors can include credential values or request headers.
        // The redacted model surface simply omits that provider.
      }
    }
    return { status: 200, body: { models } };
  }

  async #workspaceCandidateValidate(
    claims: GatewayAssertionClaims,
    body: unknown,
    correlationId?: string,
  ): Promise<GatewayRpcResult> {
    if (!isWorkspaceCandidateValidateBody(body))
      return publicError(400, 'validation_error', 'workspace request is invalid');
    const result = this.#workspaceRegistry.validateCandidate(body.absolutePath, claims.sub);
    await this.#audit.write(
      createSafeLogMetadata({
        operation: 'workspace_candidate_validate',
        outcome: result.valid ? 'allowed' : 'denied',
        reasonCode: result.valid ? 'accepted' : result.reasonCode,
        ...(correlationId ? { correlationId } : {}),
      }),
    );
    return { status: 200, body: result };
  }

  async #workspaceCandidateBrowse(
    claims: GatewayAssertionClaims,
    body: unknown,
    correlationId?: string,
  ): Promise<GatewayRpcResult> {
    if (!isWorkspaceCandidateBrowseBody(body))
      return publicError(400, 'validation_error', 'workspace request is invalid');
    const result = this.#workspaceRegistry.browse(body.candidateId, body.child, claims.sub);
    await this.#audit.write(
      createSafeLogMetadata({
        operation: 'workspace_candidate_browse',
        outcome: 'allowed',
        reasonCode: 'accepted',
        ...(correlationId ? { correlationId } : {}),
      }),
    );
    return { status: 200, body: result };
  }

  async #workspaceCandidateSelect(
    claims: GatewayAssertionClaims,
    body: unknown,
    correlationId?: string,
  ): Promise<GatewayRpcResult> {
    if (!isWorkspaceCandidateSelectBody(body))
      return publicError(400, 'validation_error', 'workspace request is invalid');
    const result = this.#workspaceRegistry.select(body.candidateId, body.access, claims.sub);
    await this.#audit.write(
      createSafeLogMetadata({
        operation: 'workspace_candidate_select',
        outcome: 'allowed',
        reasonCode: 'accepted',
        workspaceId: result.workspaceId,
        grantVersion: result.binding.grantVersion,
        access: result.binding.access,
        ...(correlationId ? { correlationId } : {}),
      }),
    );
    return {
      status: 200,
      body: {
        workspaceId: result.workspaceId,
        displayName: result.displayName,
        binding: {
          sessionId: result.binding.sessionId,
          ownerUserId: result.binding.ownerUserId,
          workspaceId: result.binding.workspaceId,
          grantVersion: result.binding.grantVersion,
          canonicalRoot: result.binding.canonicalRoot,
          access: result.binding.access,
        },
      },
    };
  }

  #settingsAuthority(): SettingsAuthority | undefined {
    const settings = this.#config.runtimeFactory?.settingsAuthority;
    return settings ? (settings as SettingsAuthority) : undefined;
  }

  async #settingsRead(correlationId?: string): Promise<GatewayRpcResult> {
    const settings = this.#settingsAuthority();
    if (!settings) return publicError(503, 'settings_unavailable', 'settings unavailable', true);
    const projection = buildSettingsProjection(settings, this.#config.allowWrite ? 'read_write' : 'read');
    await this.#audit.write(
      createSafeLogMetadata({
        operation: 'settings_read',
        outcome: 'allowed',
        reasonCode: 'accepted',
        ...(correlationId ? { correlationId } : {}),
      }),
    );
    return { status: 200, body: projection };
  }

  async #settingsWrite(body: unknown, correlationId?: string): Promise<GatewayRpcResult> {
    const settings = this.#settingsAuthority();
    if (!settings) return publicError(503, 'settings_unavailable', 'settings unavailable', true);
    if (!isSettingsWriteBody(body)) return publicError(400, 'validation_error', 'settings request is invalid');
    return await this.#withSettingsMutation(async () => {
      const projection = applySettingsChanges(settings, body.expectedRevision, body.changes);
      await this.#audit.write(
        createSafeLogMetadata({
          operation: 'settings_write',
          outcome: 'allowed',
          reasonCode: 'accepted',
          ...(correlationId ? { correlationId } : {}),
        }),
      );
      return { status: 200, body: { committed: true, revision: projection.revision, projection } };
    });
  }

  async #credentialWrite(credentialId: string, body: unknown, correlationId?: string): Promise<GatewayRpcResult> {
    const settings = this.#settingsAuthority();
    if (!settings) return publicError(503, 'settings_unavailable', 'settings unavailable', true);
    if (!isCredentialWriteBody(body)) return publicError(400, 'validation_error', 'credential request is invalid');
    return await this.#withSettingsMutation(async () => {
      const result = setCredential(settings, credentialId, body.value);
      await this.#audit.write(
        createSafeLogMetadata({
          operation: 'credential_write',
          outcome: 'allowed',
          reasonCode: 'accepted',
          ...(correlationId ? { correlationId } : {}),
        }),
      );
      return { status: 200, body: result };
    });
  }

  async #credentialDelete(credentialId: string, correlationId?: string): Promise<GatewayRpcResult> {
    const settings = this.#settingsAuthority();
    if (!settings) return publicError(503, 'settings_unavailable', 'settings unavailable', true);
    return await this.#withSettingsMutation(async () => {
      const result = deleteCredential(settings, credentialId);
      await this.#audit.write(
        createSafeLogMetadata({
          operation: 'credential_delete',
          outcome: 'allowed',
          reasonCode: 'accepted',
          ...(correlationId ? { correlationId } : {}),
        }),
      );
      return { status: 200, body: result };
    });
  }

  async #withSettingsMutation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#settingsMutation;
    let release!: () => void;
    this.#settingsMutation = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async #oauthLogin(resource: string, correlationId?: string): Promise<GatewayRpcResult> {
    const [provider] = resource.split('\u0000');
    if (!isOAuthAccountProvider(provider)) return publicError(400, 'validation_error', 'OAuth provider is invalid');
    return await this.#withOAuthMutation(
      async () => {
        try {
          if (this.#config.oauthLogin) await this.#config.oauthLogin(provider);
          else if (provider === 'codex') await loginToCodex();
          else await loginToGrok();
          return {
            status: 200,
            body: { status: 'completed', configured: listOAuthAccounts(provider).length > 0 },
          };
        } catch {
          return { status: 200, body: { status: 'not_completed' } };
        }
      },
      'oauth_login',
      correlationId,
    );
  }

  async #oauthSelect(resource: string, body: unknown, correlationId?: string): Promise<GatewayRpcResult> {
    const [provider] = resource.split('\u0000');
    if (!isOAuthAccountProvider(provider) || !isOAuthSelectBody(body))
      return publicError(400, 'validation_error', 'OAuth request is invalid');
    return await this.#withOAuthMutation(
      async () => {
        const ok = setActiveOAuthAccount(provider, body.accountId);
        const account = listOAuthAccounts(provider).find((item) => item.id === body.accountId);
        return {
          status: 200,
          body: { ok, isSelected: account?.isSelected === true, isInUse: account?.isInUse === true },
        };
      },
      'oauth_select',
      correlationId,
    );
  }

  async #oauthDelete(resource: string, correlationId?: string): Promise<GatewayRpcResult> {
    const [provider, accountId] = resource.split('\u0000');
    if (!isOAuthAccountProvider(provider) || !accountId)
      return publicError(400, 'validation_error', 'OAuth request is invalid');
    return await this.#withOAuthMutation(
      async () => {
        const ok = removeOAuthAccount(provider, accountId);
        return { status: 200, body: { ok } };
      },
      'oauth_delete',
      correlationId,
    );
  }

  async #withOAuthMutation(
    operation: () => Promise<GatewayRpcResult>,
    auditOperation: 'oauth_login' | 'oauth_select' | 'oauth_delete',
    correlationId?: string,
  ): Promise<GatewayRpcResult> {
    const previous = this.#oauthMutation;
    let release!: () => void;
    this.#oauthMutation = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const result = await operation();
      await this.#audit.write(
        createSafeLogMetadata({
          operation: auditOperation,
          outcome: 'allowed',
          reasonCode: 'accepted',
          ...(correlationId ? { correlationId } : {}),
        }),
      );
      return result;
    } finally {
      release();
    }
  }

  async #sessionUpdate(
    claims: GatewayAssertionClaims,
    body: unknown,
    correlationId?: string,
  ): Promise<GatewayRpcResult> {
    if (!isSessionUpdateBody(body)) return publicError(400, 'validation_error', 'session config is invalid');
    const session = this.#sessions.get(claims.sessionId!);
    if (!(session instanceof ServerSession) || session.binding.ownerUserId !== claims.sub)
      return publicError(404, 'not_found', 'session not found');
    if (session.status === 'running' || session.status === 'awaiting_interaction')
      return publicError(409, 'session_busy', 'session is busy');
    const settings = session.resources.sessionSettingsService as SettingsAuthority | undefined;
    if (!settings) return publicError(503, 'settings_unavailable', 'session settings unavailable', true);
    if (body.model !== undefined) {
      if (!this.#modelCatalog) return publicError(503, 'settings_unavailable', 'model catalog unavailable', true);
      const provider = String(settings.getDynamic('agent.provider') ?? '');
      const models = await this.#modelCatalog.load(provider);
      if (!models.models.some((model) => model.id === body.model))
        return publicError(422, 'validation_error', 'model is unavailable');
      session.service.setModel(body.model);
    }
    if (body.reasoningEffort !== undefined) session.service.setReasoningEffort(body.reasoningEffort as any);
    if (body.mode !== undefined) {
      const profileId = (
        {
          standard: 'builtin:standard',
          lite: 'builtin:lite',
          plan: 'builtin:plan',
          mentor: 'builtin:mentor',
          orchestrator: 'builtin:orchestrator',
        } as Record<string, string>
      )[body.mode];
      settings.setDynamic('app.activeProfileId', profileId, { persist: false });
    }
    const result = sessionConfigProjection(session);
    await this.#audit.write(
      createSafeLogMetadata({
        operation: 'session_update',
        outcome: 'allowed',
        reasonCode: 'accepted',
        sessionId: session.sessionId,
        workspaceId: session.binding.workspaceId,
        ...(correlationId ? { correlationId } : {}),
      }),
    );
    return { status: 200, body: result };
  }

  #interactionBindingFor(
    sessionId: string,
    snapshot: { interactionId: number; approval: unknown },
    turnId: string,
  ): InteractionBinding {
    const current = this.#interactionBindings.get(sessionId);
    if (current && current.expectedInteractionId === snapshot.interactionId) return current;
    const publicInteractionId = crypto.randomUUID();
    const dto = projectPendingInteraction(snapshot.approval as Record<string, unknown>, publicInteractionId, 1);
    const binding: InteractionBinding = {
      publicInteractionId,
      expectedInteractionId: snapshot.interactionId,
      continuationGeneration: crypto.randomUUID(),
      revision: 1,
      turnId,
      variant: dto.variant,
      dto,
      owner: 'root',
    };
    this.#interactionBindings.set(sessionId, binding);
    this.#countInteraction('interaction_presented');
    return binding;
  }

  #countInteraction(metric: InteractionMetric): void {
    this.#interactionCounters.set(metric, (this.#interactionCounters.get(metric) ?? 0) + 1);
  }

  #backgroundInteractionBinding(
    sessionId: string,
    turnId: string,
    event: Extract<ConversationEvent, { type: 'subagent_approval_required' | 'subagent_question' }>,
    session: ServerSession,
  ): InteractionBinding | undefined {
    const publicInteractionId = crypto.randomUUID();
    if (event.type === 'subagent_approval_required') {
      const snapshot = session.service.backgroundSubagentApprovals.getSnapshot();
      const entry = snapshot.current;
      if (!entry) return undefined;
      const dto = projectPendingInteraction(
        {
          agentName: event.role,
          toolName: entry.toolName,
          callId: entry.toolCallId,
          argumentsText: entry.argumentsText,
        },
        publicInteractionId,
        1,
      );
      const binding: InteractionBinding = {
        publicInteractionId,
        expectedInteractionId: 0,
        continuationGeneration: crypto.randomUUID(),
        revision: 1,
        turnId,
        variant: dto.variant,
        dto,
        owner: 'background_approval',
        childRunId: event.agentId,
        childRole: event.role,
        backgroundEntry: entry,
        backgroundRevision: snapshot.revision,
      };
      this.#interactionBindings.set(sessionId, binding);
      return binding;
    }
    const argumentsText = JSON.stringify({
      questions: [{ question: event.question, options: [], is_multi_select: false }],
    });
    const dto = projectPendingInteraction(
      { agentName: event.role, toolName: 'ask_user', argumentsText },
      publicInteractionId,
      1,
    );
    const binding: InteractionBinding = {
      publicInteractionId,
      expectedInteractionId: 0,
      continuationGeneration: crypto.randomUUID(),
      revision: 1,
      turnId,
      variant: dto.variant,
      dto,
      owner: 'background_question',
      childRunId: event.runId,
      childMessageId: event.messageId,
      childRole: event.role,
    };
    this.#interactionBindings.set(sessionId, binding);
    return binding;
  }

  async #ensurePersistedSession(ownerUserId: string, sessionId: string): Promise<GatewayPersistedSession> {
    const existing = this.#persisted.get(sessionId);
    if (existing) {
      if (existing.record.ownerUserId !== ownerUserId) throw new GatewayPersistenceError('owner_mismatch');
      return existing;
    }
    const persistence = this.#config.persistence;
    if (!persistence) throw new GatewayPersistenceError('not_found', 'session not found');
    const record = persistence.index.getForOwner(ownerUserId, sessionId);
    const grantVersion = Number(record.grantVersion);
    if (!Number.isSafeInteger(grantVersion))
      throw new GatewayPersistenceError('readonly', 'session grant version is invalid');
    let binding: SessionBinding;
    try {
      binding = this.#admission.restore(sessionId, ownerUserId, record.workspaceId, grantVersion);
    } catch {
      throw new GatewayPersistenceError('not_found', 'session not found');
    }
    try {
      const reopened = await persistence.open(binding);
      this.#persisted.set(sessionId, reopened);
      return reopened;
    } catch (error) {
      this.#admission.remove(sessionId);
      throw error;
    }
  }

  async #projectionFor(ownerUserId: string, sessionId: string): Promise<SessionProjectionSource> {
    const persistence = this.#config.persistence;
    const persisted = await this.#ensurePersistedSession(ownerUserId, sessionId);
    if (!persistence) throw new GatewayPersistenceError('not_found', 'session not found');
    return await createSessionProjectionSource({
      index: persistence.index,
      layout: persistence.layout,
      ownerUserId,
      sessionId,
      journal: persisted.persistence.journal,
      liveInteraction: () => {
        const session = this.#sessions.get(sessionId);
        if (!(session instanceof ServerSession)) return null;
        const snapshot = session.service.getPendingInteractionSnapshot();
        if (!snapshot) return null;
        const existingBinding = this.#interactionBindings.get(sessionId);
        const turnId = session.activeTurnId ?? existingBinding?.turnId;
        if (!turnId) return null;
        // A projection/read is observational. Only the approval event path
        // may create a public binding; reconnects must never mint or replace
        // the ID that the first viewport was given.
        if (!existingBinding || existingBinding.expectedInteractionId !== snapshot.interactionId) return null;
        const binding = existingBinding;
        return Promise.resolve({
          state: 'pending' as const,
          interaction: interactionDtoFromSnapshot(snapshot, binding.publicInteractionId, binding.revision),
          turnId: binding.turnId,
        });
      },
    });
  }

  async #submitMessage(claims: GatewayAssertionClaims, body: unknown): Promise<GatewayRpcResult> {
    if (hasAttachments(body)) return publicError(422, 'attachments_not_enabled', 'Attachments are not available');
    if (!this.#admissions || !this.#config.persistence)
      return publicError(503, 'persistence_unavailable', 'gateway persistence unavailable', true);
    if (!isMessageBody(body)) return publicError(400, 'validation_error', 'message request is invalid');
    let session = this.#sessions.get(claims.sessionId!);
    let persisted = this.#persisted.get(claims.sessionId!);
    if (!(session instanceof ServerSession) || !persisted) {
      // A session from a previous gateway process has no live runtime; revive
      // it through the same factory path a fresh session uses.
      const restored = await this.#ensureLiveRuntime(claims.sub, claims.sessionId!);
      if (restored && 'body' in restored) return restored;
      if (restored) {
        session = restored.session;
        persisted = restored.persisted;
      }
    }
    if (!(session instanceof ServerSession) || !persisted)
      return publicError(409, 'session_not_admitting', 'session is not admitting messages');
    // Owner scoping holds on every path that reaches admission, live or
    // restored: a session owned by someone else does not exist for this caller.
    if (session.binding.ownerUserId !== claims.sub) return publicError(404, 'not_found', 'session not found');
    const turnId = crypto.randomUUID();
    try {
      const result = await this.#admissions.admit({
        ownerUserId: claims.sub,
        sessionId: claims.sessionId!,
        clientRequestId: body.clientRequestId,
        body,
        turnId,
        runtime: session,
        persistence: persisted.persistence.critical,
        term2Fact: { type: 'user_message', message: { id: turnId, sender: 'user', text: body.text } },
        acceptedEvent: {
          sessionId: claims.sessionId!,
          type: 'user_message_accepted',
          payload: { turnId, clientRequestId: body.clientRequestId, messageId: turnId },
        },
        beforeCommit: () =>
          this.#enqueueEventPersistence(claims.sessionId!, async () => {
            await persisted.persistence.critical.appendJournalCritical({
              sessionId: claims.sessionId!,
              type: 'assistant_started',
              payload: { turnId },
            });
          }),
      });
      if (result.kind === 'rejected') {
        return result.reason === 'queue_full'
          ? publicError(429, 'queue_full', 'message queue is full', true)
          : publicError(409, 'session_not_admitting', 'session is not admitting messages');
      }
      return {
        status: 202,
        body: {
          sessionId: claims.sessionId,
          clientRequestId: body.clientRequestId,
          turnId: result.record.turnId,
          accepted: true,
          replayed: result.replayed,
        },
      };
    } catch (error) {
      return this.#mapError(error);
    }
  }

  async #abortSession(claims: GatewayAssertionClaims, body: unknown): Promise<GatewayRpcResult> {
    if (!isTurnBody(body)) return publicError(400, 'validation_error', 'abort request is invalid');
    const session = this.#sessions.get(claims.sessionId!);
    if (!(session instanceof ServerSession))
      return publicError(409, 'session_not_admitting', 'session is not admitting');
    const outcome = await session.abort(body.turnId);
    if (outcome.kind === 'aborted') {
      const persisted = this.#persisted.get(claims.sessionId!);
      if (persisted) {
        await this.#enqueueEventPersistence(claims.sessionId!, async () => {
          const admissions = this.#config.persistence?.index.listAdmissions(claims.sub, claims.sessionId!) ?? [];
          for (const discardedTurnId of outcome.discardedTurnIds) {
            if (hasTerminalTurnEvent(persisted.persistence.journal.events(), discardedTurnId)) continue;
            const admission = admissions.find((candidate) => candidate.turnId === discardedTurnId);
            await persisted.persistence.journal.append(
              {
                sessionId: claims.sessionId!,
                type: 'user_message_rejected',
                payload: {
                  turnId: discardedTurnId,
                  ...(admission ? { clientRequestId: admission.clientRequestId } : {}),
                  reason: 'queue_discarded',
                },
              },
              { durability: 'critical' },
            );
            if (admission) {
              this.#config.persistence?.index.updateAdmission(
                claims.sub,
                claims.sessionId!,
                admission.clientRequestId,
                {
                  state: 'rejected',
                  result: 'queue_discarded',
                },
              );
            }
          }
          await persisted.persistence.journal.append(
            {
              sessionId: claims.sessionId!,
              type: 'turn_aborted',
              payload: { turnId: body.turnId, outcome: 'aborted' },
            },
            { durability: 'critical' },
          );
        });
      }
      return { status: 202, body: { sessionId: claims.sessionId!, turnId: body.turnId, accepted: true } };
    }
    if (outcome.kind === 'already_settled' || outcome.kind === 'no_op')
      return {
        status: 200,
        body: { sessionId: claims.sessionId, turnId: body.turnId, accepted: false, alreadySettled: true },
      };
    return publicError(409, 'session_not_admitting', 'session is interrupted');
  }

  async #invokeCommand(
    claims: GatewayAssertionClaims,
    body: unknown,
    correlationId?: string,
  ): Promise<GatewayRpcResult> {
    if (!isCommandBody(body)) return publicError(400, 'validation_error', 'command request is invalid');
    let session = this.#sessions.get(claims.sessionId!);
    if (!session || session.binding.ownerUserId !== claims.sub) {
      // A restored session has no live runtime; commands revive it the same
      // way message_submit does. Sessions unknown to this owner keep the 404.
      const restored = await this.#ensureLiveRuntime(claims.sub, claims.sessionId!);
      if (restored && 'body' in restored) return restored;
      if (restored) session = restored.session;
    }
    if (!session || session.binding.ownerUserId !== claims.sub) {
      return publicError(404, 'not_found', 'session not found');
    }
    if (!(session instanceof ServerSession)) {
      return publicError(409, 'session_not_admitting', 'session is not admitting commands');
    }
    if (session.status === 'running' || session.status === 'awaiting_interaction') {
      return publicError(409, 'session_busy', 'session is busy');
    }
    if (!COMMAND_ALLOWLIST.has(body.commandId)) {
      return publicError(422, 'command_not_allowed', 'command is not allowed');
    }

    await this.#audit.write(
      createSafeLogMetadata({
        operation: 'command_invoke',
        outcome: 'allowed',
        reasonCode: 'accepted',
        sessionId: session.sessionId,
        workspaceId: session.binding.workspaceId,
        grantVersion: session.binding.grantVersion,
        access: session.binding.access,
        ...(correlationId ? { correlationId } : {}),
      }),
    );

    const inflightKey = `${claims.sub}:${session.sessionId}:${body.clientRequestId}`;
    const bodyHash = normalizedBodyHash(body);

    const inflight = this.#inflightCommands.get(inflightKey);
    if (inflight) {
      if (inflight.bodyHash !== bodyHash) {
        throw new GatewayPersistenceError('conflict', 'idempotency key has a different body');
      }
      const existing = await inflight.promise;
      return {
        ...existing,
        body: {
          ...(existing.body as Record<string, unknown>),
          replayed: true,
        },
      };
    }

    if (this.#admissions) {
      const lookup = this.#admissions.lookup(claims.sub, session.sessionId, body.clientRequestId, body);
      if (lookup.kind === 'conflict') {
        throw new GatewayPersistenceError('conflict', 'idempotency key has a different body');
      }
      if (lookup.kind === 'replayed') {
        if (body.commandId === 'compact') {
          const parts = lookup.record.turnId.split(':');
          if (lookup.record.result === 'failed' || parts[1] === 'failed') {
            return publicError(409, 'compact_failed', 'compaction failed', false);
          }
          if (parts[1] === 'in_progress') {
            return publicError(409, 'compact_interrupted', 'compaction was interrupted', false);
          }
          if (parts[1] !== 'completed' && parts[1] !== 'not_reduced' && parts[1] !== 'nothing_to_retry') {
            return publicError(500, 'compact_invalid_state', 'invalid compaction record state', false);
          }
          const outcome = parts[1];
          const tokensBefore = parts[2] ? Number(parts[2]) : undefined;
          const tokensAfter = parts[3] ? Number(parts[3]) : undefined;
          return {
            status: 200,
            body: {
              commandId: body.commandId,
              outcome,
              ...(tokensBefore !== undefined && !Number.isNaN(tokensBefore) ? { tokensBefore } : {}),
              ...(tokensAfter !== undefined && !Number.isNaN(tokensAfter) ? { tokensAfter } : {}),
              replayed: true,
            },
          };
        }
        if (lookup.record.turnId === 'nothing_to_retry') {
          return {
            status: 200,
            body: {
              commandId: body.commandId,
              outcome: 'nothing_to_retry',
              replayed: true,
            },
          };
        }
        if (lookup.record.result === 'failed') {
          return publicError(409, 'retry_failed', 'retry failed', false);
        }
        return {
          status: 200,
          body: {
            commandId: body.commandId,
            outcome: 'accepted',
            turnId: lookup.record.turnId,
            replayed: true,
          },
        };
      }
    }

    const persisted = this.#persisted.get(claims.sessionId!);
    if (this.#config.persistence && !persisted) {
      return publicError(503, 'persistence_unavailable', 'gateway persistence unavailable', true);
    }

    const inflightPromise = (async (): Promise<GatewayRpcResult> => {
      try {
        if (body.commandId === 'compact') {
          if (this.#admissions) {
            this.#admissions.prepare({
              ownerUserId: claims.sub,
              sessionId: session.sessionId,
              clientRequestId: body.clientRequestId,
              body,
              turnId: 'compact:in_progress',
            });
            this.#config.persistence?.index.updateAdmission(claims.sub, session.sessionId, body.clientRequestId, {
              state: 'accepted',
              result: 'accepted',
              phase: 'committed',
              turnId: 'compact:in_progress',
            });
          }

          let outcome: 'completed' | 'not_reduced' | 'nothing_to_retry' = 'nothing_to_retry';
          let tokensBefore: number | undefined;
          let tokensAfter: number | undefined;
          const compactTurnId = crypto.randomUUID();
          try {
            const resultText = await session.withCommandTurn(compactTurnId, () => session.service.compactContext());
            const match = resultText.match(/Context compacted locally\s*(?:\((\d+)\s*→\s*(\d+)\s*estimated tokens\))?/);
            const isCompacted = resultText.toLowerCase().includes('context compacted locally');
            tokensBefore = match?.[1] ? Number(match[1]) : undefined;
            tokensAfter = match?.[2] ? Number(match[2]) : undefined;
            // A compaction that grew the context is not a completed one; the
            // numbers come from the same estimator on both sides.
            outcome = !isCompacted
              ? 'nothing_to_retry'
              : tokensBefore !== undefined && tokensAfter !== undefined && tokensAfter >= tokensBefore
              ? 'not_reduced'
              : 'completed';

            if (this.#admissions) {
              const turnId = `compact:${outcome}:${tokensBefore ?? ''}:${tokensAfter ?? ''}`;
              this.#config.persistence?.index.updateAdmission(claims.sub, session.sessionId, body.clientRequestId, {
                state: 'terminal',
                result: 'accepted',
                phase: 'committed',
                turnId,
              });
            }
          } catch (error) {
            if (this.#admissions) {
              try {
                this.#config.persistence?.index.updateAdmission(claims.sub, session.sessionId, body.clientRequestId, {
                  state: 'terminal',
                  result: 'failed',
                  phase: 'committed',
                  turnId: 'compact:failed',
                });
              } catch {
                // ignore
              }
            }
            throw error;
          }

          return {
            status: 200,
            body: {
              commandId: 'compact',
              outcome,
              ...(tokensBefore !== undefined ? { tokensBefore } : {}),
              ...(tokensAfter !== undefined ? { tokensAfter } : {}),
            },
          };
        }

        if (body.commandId === 'retry-tool') {
          const lastTool = session.service.peekLastToolOutput();
          if (!lastTool) {
            if (this.#admissions) {
              this.#admissions.prepare({
                ownerUserId: claims.sub,
                sessionId: session.sessionId,
                clientRequestId: body.clientRequestId,
                body,
                turnId: 'nothing_to_retry',
              });
              this.#config.persistence?.index.updateAdmission(claims.sub, session.sessionId, body.clientRequestId, {
                state: 'terminal',
                result: 'accepted',
                phase: 'committed',
                turnId: 'nothing_to_retry',
              });
            }
            return {
              status: 200,
              body: {
                commandId: 'retry-tool',
                outcome: 'nothing_to_retry',
              },
            };
          }

          const turnId = crypto.randomUUID();
          if (this.#admissions && persisted) {
            const runtime = session.createRetryRuntime('retry-tool');
            try {
              const result = await this.#admissions.admit({
                ownerUserId: claims.sub,
                sessionId: session.sessionId,
                clientRequestId: body.clientRequestId,
                body,
                turnId,
                runtime,
                persistence: persisted.persistence.critical,
                acceptedEvent: {
                  sessionId: session.sessionId,
                  type: 'assistant_started',
                  payload: { turnId, clientRequestId: body.clientRequestId },
                },
              });

              if (result.kind === 'rejected') {
                return result.reason === 'queue_full'
                  ? publicError(429, 'queue_full', 'message queue is full', true)
                  : publicError(409, 'session_not_admitting', 'session is not admitting commands');
              }

              return {
                status: 200,
                body: {
                  commandId: 'retry-tool',
                  outcome: 'accepted',
                  turnId: result.record.turnId,
                  ...(result.replayed ? { replayed: true } : {}),
                },
              };
            } catch (error) {
              try {
                await this.#enqueueEventPersistence(session.sessionId, async () => {
                  const events = persisted.persistence.journal.events();
                  const hasStarted = events.some((e) => e.type === 'assistant_started' && e.payload?.turnId === turnId);
                  const hasTerminal = events.some(
                    (e) =>
                      (e.type === 'turn_completed' || e.type === 'turn_failed' || e.type === 'turn_aborted') &&
                      e.payload?.turnId === turnId,
                  );
                  if (hasStarted && !hasTerminal) {
                    await persisted.persistence.critical.appendJournalCritical({
                      sessionId: session.sessionId,
                      type: 'turn_failed',
                      payload: { turnId, outcome: 'failed', reason: 'runtime_error' },
                    });
                  }
                });
              } catch {
                // ignore secondary journal error
              }
              return this.#mapError(error);
            }
          }

          void session.service.retryLastToolOutput({ preferredMessageId: turnId }).catch(() => undefined);
          return {
            status: 200,
            body: {
              commandId: 'retry-tool',
              outcome: 'accepted',
              turnId,
            },
          };
        }

        if (body.commandId === 'retry-turn') {
          const state = session.service.exportState();
          if (!hasFailedTurnToRetry(state.history)) {
            if (this.#admissions) {
              this.#admissions.prepare({
                ownerUserId: claims.sub,
                sessionId: session.sessionId,
                clientRequestId: body.clientRequestId,
                body,
                turnId: 'nothing_to_retry',
              });
              this.#config.persistence?.index.updateAdmission(claims.sub, session.sessionId, body.clientRequestId, {
                state: 'terminal',
                result: 'accepted',
                phase: 'committed',
                turnId: 'nothing_to_retry',
              });
            }
            return {
              status: 200,
              body: {
                commandId: 'retry-turn',
                outcome: 'nothing_to_retry',
              },
            };
          }

          const turnId = crypto.randomUUID();
          if (this.#admissions && persisted) {
            const runtime = session.createRetryRuntime('retry-turn');
            try {
              const result = await this.#admissions.admit({
                ownerUserId: claims.sub,
                sessionId: session.sessionId,
                clientRequestId: body.clientRequestId,
                body,
                turnId,
                runtime,
                persistence: persisted.persistence.critical,
                acceptedEvent: {
                  sessionId: session.sessionId,
                  type: 'assistant_started',
                  payload: { turnId, clientRequestId: body.clientRequestId },
                },
              });

              if (result.kind === 'rejected') {
                return result.reason === 'queue_full'
                  ? publicError(429, 'queue_full', 'message queue is full', true)
                  : publicError(409, 'session_not_admitting', 'session is not admitting commands');
              }

              return {
                status: 200,
                body: {
                  commandId: 'retry-turn',
                  outcome: 'accepted',
                  turnId: result.record.turnId,
                  ...(result.replayed ? { replayed: true } : {}),
                },
              };
            } catch (error) {
              try {
                await this.#enqueueEventPersistence(session.sessionId, async () => {
                  const events = persisted.persistence.journal.events();
                  const hasStarted = events.some((e) => e.type === 'assistant_started' && e.payload?.turnId === turnId);
                  const hasTerminal = events.some(
                    (e) =>
                      (e.type === 'turn_completed' || e.type === 'turn_failed' || e.type === 'turn_aborted') &&
                      e.payload?.turnId === turnId,
                  );
                  if (hasStarted && !hasTerminal) {
                    await persisted.persistence.critical.appendJournalCritical({
                      sessionId: session.sessionId,
                      type: 'turn_failed',
                      payload: { turnId, outcome: 'failed', reason: 'runtime_error' },
                    });
                  }
                });
              } catch {
                // ignore secondary journal error
              }
              return this.#mapError(error);
            }
          }

          void session.service.retryLastFailedTurn({ preferredMessageId: turnId }).catch(() => undefined);
          return {
            status: 200,
            body: {
              commandId: 'retry-turn',
              outcome: 'accepted',
              turnId,
            },
          };
        }

        return publicError(422, 'command_not_allowed', 'command is not allowed');
      } finally {
        this.#inflightCommands.delete(inflightKey);
      }
    })();

    this.#inflightCommands.set(inflightKey, { promise: inflightPromise, bodyHash });
    try {
      return await inflightPromise;
    } catch (error) {
      return this.#mapError(error);
    }
  }

  async #resolveInteraction(
    claims: GatewayAssertionClaims,
    interactionId: string,
    body: unknown,
  ): Promise<GatewayRpcResult> {
    if (!isInteractionResolveRequest(body))
      return publicError(400, 'validation_error', 'interaction request is invalid');
    const projection = await this.#projectionFor(claims.sub, claims.sessionId!);
    const session = this.#sessions.get(claims.sessionId!);
    const binding = this.#interactionBindings.get(claims.sessionId!);
    const snapshot = session instanceof ServerSession ? session.service.getPendingInteractionSnapshot() : null;
    if (
      session instanceof ServerSession &&
      binding?.publicInteractionId === interactionId &&
      binding.owner !== 'root'
    ) {
      if (body.revision !== binding.revision) return publicError(409, 'stale_interaction', 'interaction is stale');
      let decision: ReturnType<typeof decideInteraction>;
      try {
        decision = decideInteraction(binding.dto, body);
      } catch (error) {
        if (error instanceof InteractionProtocolError)
          return publicError(400, 'validation_error', 'interaction decision is invalid');
        throw error;
      }
      let accepted = false;
      if (
        binding.owner === 'background_approval' &&
        binding.backgroundEntry &&
        binding.backgroundRevision !== undefined
      ) {
        const current = session.service.backgroundSubagentApprovals.getSnapshot();
        if (current.revision !== binding.backgroundRevision || current.current?.runId !== binding.backgroundEntry.runId)
          return publicError(409, 'stale_interaction', 'interaction is stale');
        const result = session.service.backgroundSubagentApprovals.resolve({
          revision: binding.backgroundRevision,
          entry: binding.backgroundEntry,
          decision: { answer: decision.answer, rejectionReason: decision.rejectionReason },
        });
        accepted = result.kind === 'resolved';
      } else if (binding.owner === 'background_question' && binding.childRunId && binding.childMessageId) {
        accepted = session.service.answerBackgroundSubagentQuestion(
          binding.childRunId,
          binding.childMessageId,
          decision.approvalAnswer ?? decision.answer,
        );
      }
      if (!accepted) return publicError(409, 'stale_interaction', 'interaction is stale');
      this.#countInteraction('interaction_resolved');
      await this.#enqueueEventPersistence(claims.sessionId!, async () => {
        const persisted = this.#persisted.get(claims.sessionId!);
        if (!persisted) throw new GatewayPersistenceError('not_found', 'session persistence is unavailable');
        persisted.persistence.interactionCheckpoint.clear();
        await persisted.persistence.journal.append(
          {
            sessionId: claims.sessionId!,
            type: 'interaction_resolved',
            payload: {
              turnId: binding.turnId,
              interactionId,
              outcome: decision.outcome,
              variant: binding.variant,
            },
          },
          { durability: 'critical' },
        );
      });
      this.#interactionBindings.delete(claims.sessionId!);
      return {
        status: 202,
        body: { sessionId: claims.sessionId!, turnId: binding.turnId, interactionId, accepted: true },
      };
    }
    // A live runtime owns the current interaction. A public ID from an older
    // presentation is stale even when the durable journal still says the
    // interaction was recovered during startup.
    if (snapshot !== null && (!binding || binding.publicInteractionId !== interactionId)) {
      this.#countInteraction('interaction_stale');
      return publicError(409, 'stale_interaction', 'interaction is stale');
    }
    if (projection.interaction?.state === 'recovered' && snapshot === null)
      return publicError(409, 'interaction_not_resolvable', 'interaction is not resolvable');
    if (!(session instanceof ServerSession)) return publicError(404, 'not_found', 'session not found');
    if (projection.resolvedInteractionIds.has(interactionId)) {
      this.#countInteraction('interaction_duplicate');
      return publicError(409, 'interaction_already_resolved', 'interaction is already resolved');
    }
    if (!binding || binding.publicInteractionId !== interactionId) {
      this.#countInteraction('interaction_stale');
      return publicError(409, 'stale_interaction', 'interaction is stale');
    }
    const resolutionCode = classifyInteractionResolution(projection.interaction, snapshot !== null);
    if (resolutionCode) {
      this.#countInteraction(
        resolutionCode === 'interaction_already_resolved' ? 'interaction_duplicate' : 'interaction_stale',
      );
      return publicError(
        409,
        resolutionCode,
        resolutionCode === 'interaction_not_resolvable'
          ? 'interaction is not resolvable'
          : 'interaction is already resolved',
      );
    }
    if (!snapshot) {
      this.#countInteraction('interaction_duplicate');
      return publicError(409, 'interaction_already_resolved', 'interaction is already resolved');
    }
    if (body.revision !== binding.revision) {
      this.#countInteraction('interaction_stale');
      return publicError(409, 'stale_interaction', 'interaction revision is stale');
    }
    const continuationAbortGeneration = session.abortGeneration;
    let decision: ReturnType<typeof decideInteraction>;
    try {
      decision = decideInteraction(binding.dto, body);
    } catch (error) {
      if (error instanceof InteractionProtocolError) {
        this.#countInteraction('interaction_sanitization_rejected');
        return publicError(400, 'validation_error', 'interaction decision is invalid');
      }
      throw error;
    }
    try {
      const result = session.resolvePendingInteraction({
        expectedInteractionId: binding.expectedInteractionId,
        answer: decision.answer,
        rejectionReason: decision.rejectionReason,
        approvalAnswer: decision.approvalAnswer,
      });
      if (result.kind === 'awaiting_next_question') {
        binding.revision += 1;
        binding.dto = projectPendingInteraction(
          result.snapshot.approval as unknown as Record<string, unknown>,
          binding.publicInteractionId,
          binding.revision,
          result.snapshot.askUserAnswers,
          result.snapshot.currentAskUserQuestionIndex,
        );
        await this.#enqueueEventPersistence(claims.sessionId!, async () => {
          const persisted = this.#persisted.get(claims.sessionId!);
          if (!persisted) throw new GatewayPersistenceError('not_found', 'session persistence is unavailable');
          persisted.persistence.interactionCheckpoint.save({
            turnId: binding.turnId,
            interaction: binding.dto,
            revision: binding.revision,
            generation: binding.continuationGeneration,
          });
          await persisted.persistence.journal.append(
            {
              sessionId: claims.sessionId!,
              type: 'interaction_updated',
              payload: { turnId: binding.turnId, interaction: binding.dto },
            },
            { durability: 'critical' },
          );
        });
        this.#countInteraction('interaction_updated');
        return { status: 200, body: { accepted: false, interaction: binding.dto } };
      }
      if (result.kind === 'none')
        return publicError(409, 'interaction_already_resolved', 'interaction is already resolved');
      if (result.kind === 'stale_interaction') return publicError(409, 'stale_interaction', 'interaction is stale');
      await this.#enqueueEventPersistence(claims.sessionId!, async () => {
        const persisted = this.#persisted.get(claims.sessionId!);
        if (!persisted) throw new GatewayPersistenceError('not_found', 'session persistence is unavailable');
        await persisted.persistence.journal.append(
          {
            sessionId: claims.sessionId!,
            type: 'interaction_resolved',
            payload: {
              turnId: binding.turnId,
              interactionId: binding.publicInteractionId,
              outcome: decision.outcome,
              variant: binding.variant,
            },
          },
          { durability: 'critical' },
        );
        persisted.persistence.interactionCheckpoint.clear();
      });
      this.#interactionBindings.delete(claims.sessionId!);
      this.#countInteraction('interaction_resolved');
      try {
        if (session.abortGeneration !== continuationAbortGeneration || session.activeTurnId !== binding.turnId) {
          throw new ServerSessionError('interrupted');
        }
        await session.service.handleApprovalDecision(decision.answer, decision.rejectionReason, {
          approvalAnswer: decision.approvalAnswer,
        });
      } catch (error) {
        this.#countInteraction('interaction_continuation_failed');
        await this.#recordContinuationFailure(claims.sessionId!, binding);
        throw error;
      }
      return {
        status: 202,
        body: {
          sessionId: claims.sessionId!,
          turnId: binding.turnId,
          interactionId: binding.publicInteractionId,
          accepted: true,
        },
      };
    } catch (error) {
      if (error instanceof ServerSessionError && error.code === 'stale_interaction')
        return publicError(409, 'stale_interaction', 'interaction is stale');
      throw error;
    }
  }

  async #eventsResponse(
    claims: GatewayAssertionClaims,
    url: URL,
    request: import('node:http').IncomingMessage,
  ): Promise<GatewayRpcResult> {
    const queryCursor = url.searchParams.get('after');
    const headerCursor = typeof request.headers['last-event-id'] === 'string' ? request.headers['last-event-id'] : null;
    if (queryCursor !== null && headerCursor !== null && queryCursor !== headerCursor)
      return publicError(400, 'protocol_conflict', 'event cursors do not match');
    const after = parseEventCursor(queryCursor ?? headerCursor);
    if (after.error) return publicError(400, after.error, 'event cursor is invalid');
    const source = await this.#projectionFor(claims.sub, claims.sessionId!);
    let activeResponse: import('node:http').ServerResponse | null = null;
    let closed = false;
    let buffered: import('./persistence/contracts.js').AgentEventEnvelope[] = [];
    let unsubscribe: () => void = () => undefined;
    const closeSlowSubscriber = () => {
      if (closed) return;
      closed = true;
      unsubscribe();
      if (activeResponse && !activeResponse.writableEnded) activeResponse.destroy();
    };
    const writeEvent = (
      response: import('node:http').ServerResponse,
      event: import('./persistence/contracts.js').AgentEventEnvelope,
    ): void => {
      if (!isPublicEventEnvelope(event)) return closeSlowSubscriber();
      const accepted = response.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
      if (!accepted) closeSlowSubscriber();
    };
    const live = source.subscribeFrom(after.value, (event) => {
      if (closed) return;
      if (!activeResponse) {
        if (buffered.length >= MAX_BUFFERED_SSE_EVENTS) return closeSlowSubscriber();
        buffered.push(event);
        return;
      }
      writeEvent(activeResponse, event);
    });
    if (live.kind === 'reload_required') {
      const status = live.reason === 'cursor_compacted' ? 410 : 503;
      const code = live.reason === 'cursor_compacted' ? 'cursor_compacted' : 'gateway_unavailable';
      return publicError(status, code, 'event replay requires a session reload', true, {
        reloadRequired: true,
        session: toSessionProjection(source),
        latestSequence: live.latestSequence,
      });
    }
    unsubscribe = live.unsubscribe;
    if (live.replay.some((event) => !isPublicEventEnvelope(event))) {
      live.unsubscribe();
      return publicError(503, 'gateway_unavailable', 'event stream is unavailable', true);
    }
    return {
      status: 200,
      body: null,
      headers: {
        'content-type': GATEWAY_EVENT_STREAM_CONTENT_TYPE,
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      },
      stream: {
        start: async (response: import('node:http').ServerResponse, request: import('node:http').IncomingMessage) => {
          activeResponse = response;
          for (const event of live.replay) {
            if (closed) break;
            writeEvent(response, event);
          }
          const queued = buffered;
          buffered = [];
          for (const event of queued) {
            if (closed) break;
            writeEvent(response, event);
          }
          const heartbeat = setInterval(() => {
            if (!response.writableEnded) {
              const accepted = response.write(`${GATEWAY_EVENT_STREAM_HEARTBEAT} ${new Date().toISOString()}\n\n`);
              if (!accepted) closeSlowSubscriber();
            }
          }, GATEWAY_EVENT_HEARTBEAT_INTERVAL_MS);
          heartbeat.unref?.();
          await new Promise<void>((resolve) => {
            const close = () => {
              clearInterval(heartbeat);
              unsubscribe();
              activeResponse = null;
              closed = true;
              resolve();
            };
            request.once('close', close);
            response.once('close', close);
          });
        },
      },
    };
  }

  async #recordContinuationFailure(sessionId: string, binding: InteractionBinding): Promise<void> {
    try {
      await this.#enqueueEventPersistence(sessionId, async () => {
        const persisted = this.#persisted.get(sessionId);
        if (!persisted) throw new GatewayPersistenceError('not_found', 'session persistence is unavailable');
        await persisted.persistence.journal.append(
          {
            sessionId,
            type: 'turn_failed',
            payload: { turnId: binding.turnId, outcome: 'failed', reason: 'interaction_continuation_failed' },
          },
          { durability: 'critical' },
        );
        persisted.persistence.interactionCheckpoint.clear();
      });
    } catch {
      // If the truthful terminal fact cannot be appended, retain a sanitized
      // checkpoint so restart recovery does not lose the interaction entirely.
      try {
        this.#persisted.get(sessionId)?.persistence.interactionCheckpoint.save({
          turnId: binding.turnId,
          interaction: binding.dto,
          revision: binding.revision,
          generation: binding.continuationGeneration,
        });
      } catch {
        // The gateway owns this persistence failure boundary; admission
        // remains fail-closed rather than fabricating a recovery fact.
      }
    }
  }

  #enqueueEventPersistence(sessionId: string, work: () => Promise<void>): Promise<void> {
    const previous = this.#eventPersistenceTails.get(sessionId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    this.#eventPersistenceTails.set(sessionId, next);
    void next.then(
      () => {
        if (this.#eventPersistenceTails.get(sessionId) === next) this.#eventPersistenceTails.delete(sessionId);
      },
      () => {
        if (this.#eventPersistenceTails.get(sessionId) === next) this.#eventPersistenceTails.delete(sessionId);
      },
    );
    return next;
  }

  async #persistConversationEvent(
    sessionId: string,
    event: ConversationEvent,
    context: { readonly turnId?: string; readonly discardedTurnIds: readonly string[] },
  ): Promise<void> {
    return this.#enqueueEventPersistence(sessionId, async () => {
      const persisted = this.#persisted.get(sessionId);
      if (!persisted) return;
      const admissions = this.#config.persistence?.index.listAdmissions(persisted.record.ownerUserId, sessionId) ?? [];
      for (const discardedTurnId of new Set(context.discardedTurnIds)) {
        if (hasTerminalTurnEvent(persisted.persistence.journal.events(), discardedTurnId)) continue;
        const admission = admissions.find((candidate) => candidate.turnId === discardedTurnId);
        await persisted.persistence.journal.append(
          {
            sessionId,
            type: 'user_message_rejected',
            payload: {
              turnId: discardedTurnId,
              ...(admission ? { clientRequestId: admission.clientRequestId } : {}),
              reason: 'queue_discarded',
            },
          },
          { durability: 'critical' },
        );
        if (admission)
          this.#config.persistence?.index.updateAdmission(
            persisted.record.ownerUserId,
            sessionId,
            admission.clientRequestId,
            { state: 'rejected', result: 'queue_discarded' },
          );
      }
      if (!context.turnId) return;
      const session = this.#sessions.get(sessionId);
      const snapshot = session instanceof ServerSession ? session.service.getPendingInteractionSnapshot() : null;
      const childBinding =
        session instanceof ServerSession &&
        (event.type === 'subagent_approval_required' || event.type === 'subagent_question')
          ? this.#backgroundInteractionBinding(sessionId, context.turnId, event, session)
          : undefined;
      const binding =
        childBinding ??
        ((event.type === 'approval_required' || event.type === 'subagent_approval_required') && snapshot
          ? this.#interactionBindingFor(sessionId, snapshot, context.turnId)
          : undefined);
      if (childBinding) {
        persisted.persistence.interactionCheckpoint.save({
          turnId: childBinding.turnId,
          interaction: childBinding.dto,
          revision: childBinding.revision,
          generation: childBinding.continuationGeneration,
          settleOnRecovery: 'child_interrupted',
          ...(childBinding.childRunId
            ? { child: { agentId: childBinding.childRunId, role: childBinding.childRole ?? 'subagent' } }
            : {}),
        });
      }
      // An ask_user answer can advance the live binding before the original
      // awaitable approval sink reaches this queue. Do not republish that
      // old presentation as a second approval after interaction_updated.
      if (
        (event.type === 'approval_required' || event.type === 'subagent_approval_required') &&
        binding?.revision &&
        binding.revision > 1
      )
        return;
      const mapped = mapConversationEvent(event, context.turnId, sessionId, binding, snapshot ?? undefined);
      if (!mapped) return;
      const transcriptFact = terminalTranscriptFact(event, context.turnId);
      if (transcriptFact) await persisted.persistence.critical.appendTranscriptCritical(transcriptFact);
      if ((mapped.type === 'approval_required' || mapped.type === 'interaction_updated') && binding) {
        persisted.persistence.interactionCheckpoint.save({
          turnId: binding.turnId,
          interaction: mapped.payload.interaction as PendingInteractionDto,
          revision: binding.revision,
          generation: binding.continuationGeneration,
        });
      }
      await persisted.persistence.journal.append(mapped, {
        durability: mapped.type === 'text_delta' || mapped.type === 'reasoning_delta' ? 'stream' : 'critical',
      });
      // Keep the sessions-list sequence counter live: stream deltas stay
      // non-blocking, but every critical event refreshes the index row so the
      // sidebar never reports a stale "1 events" for a running session.
      if (mapped.type !== 'text_delta' && mapped.type !== 'reasoning_delta') {
        this.#config.persistence?.index.update(sessionId, {
          lastPublishedSequence: persisted.persistence.journal.highWater().lastPublishedSequence,
        });
      }
      if (event.type === 'final' || event.type === 'error') {
        const admission = admissions.find((candidate) => candidate.turnId === context.turnId);
        if (admission && (admission.state === 'accepted' || admission.state === 'committed')) {
          try {
            this.#admissions?.markTerminal(
              persisted.record.ownerUserId,
              sessionId,
              admission.clientRequestId,
              event.type === 'final' ? 'accepted' : 'failed',
            );
          } catch (error) {
            if (!(error instanceof GatewayPersistenceError) || error.code !== 'not_found') throw error;
          }
        }
      }
    });
  }

  #mapError(error: unknown): GatewayRpcResult {
    if (error instanceof SettingsRpcError) {
      if (error.code === 'settings_conflict')
        return publicError(409, 'settings_conflict', 'settings changed; reload before retrying', false, {
          currentRevision: error.details?.currentRevision,
          ...(error.details?.projection ? { projection: error.details.projection } : {}),
        });
      if (error.code === 'settings_not_allowed')
        return publicError(403, 'settings_forbidden', 'settings change is not allowed');
      if (error.code === 'not_persisted')
        return publicError(503, 'settings_unavailable', 'settings could not be saved', true);
      return publicError(503, 'settings_unavailable', 'settings unavailable', true);
    }
    if (error instanceof DynamicWorkspaceRegistryError) {
      if (error.code === 'candidate_not_found' || error.code === 'candidate_expired')
        return publicError(404, 'not_found', 'workspace candidate not found');
      if (error.code === 'workspace_owner_mismatch' || error.code === 'workspace_path_escape')
        return publicError(403, 'workspace_forbidden', 'workspace access denied');
      if (error.code === 'candidate_registry_full')
        return publicError(429, 'candidate_registry_full', 'workspace candidate capacity is full', true);
      return publicError(422, 'validation_error', 'workspace candidate is unavailable');
    }
    if (error instanceof WorkspaceAdmissionError) {
      // One active session per workspace is a deliberate constraint; surface it
      // with a distinct code so clients can recover (e.g. select the existing
      // session) instead of seeing a generic protocol_conflict.
      if (error.code === 'workspace_session_exists')
        return publicError(409, 'session_busy', 'a session is already active for this workspace');
      return publicError(403, 'workspace_forbidden', 'workspace access denied');
    }
    if (error instanceof GatewayPersistenceError) {
      if (error.code === 'snapshot_unwritable')
        return publicError(503, 'snapshot_unwritable', 'session snapshot could not be persisted', true);
      if (error.code === 'not_found' || error.code === 'owner_mismatch')
        return publicError(404, 'not_found', 'session not found');
      if (error.code === 'cursor_invalid') return publicError(400, 'invalid_cursor', 'cursor is invalid');
      if (error.code === 'conflict')
        return publicError(409, 'idempotency_conflict', 'request conflicts with an existing admission');
      return publicError(503, 'persistence_unavailable', 'gateway persistence unavailable', true);
    }
    if (error instanceof ServerSessionError) {
      if (error.code === 'stale_interaction') return publicError(409, 'stale_interaction', 'interaction is stale');
      return publicError(409, 'session_not_admitting', 'session is not admitting');
    }
    if (error instanceof RuntimeFactoryError) {
      if (error.code === 'resource_limit')
        return publicError(429, 'resource_exhausted', 'session resource limit reached', true);
      if (error.code === 'provider_unavailable')
        return publicError(409, 'provider_unavailable', 'session provider is unavailable');
      if (error.code === 'invalid_binding')
        return publicError(409, 'session_not_admitting', 'session is not admitting');
      return publicError(503, 'gateway_unavailable', 'gateway unavailable', true);
    }
    return publicError(503, 'gateway_unavailable', 'gateway unavailable', true);
  }

  static create(config: GatewayLaunchConfig): Term2Gateway {
    let manifest: GatewayManifest;
    try {
      manifest = loadGatewayManifest(config.manifestPath, config.manifestSha256);
    } catch {
      throw new GatewayStartupError();
    }
    assertGatewayStartup(config, manifest);
    return new Term2Gateway(config, manifest);
  }

  get server(): GatewayServer {
    return this.#server;
  }
  get admission(): WorkspaceAdmission {
    return this.#admission;
  }
  get lifecycle(): GatewayLifecycle {
    return this.#lifecycle;
  }
  get manifestVersion(): number {
    return this.#admission.manifestVersion;
  }
  get interactionMetrics(): Readonly<Record<InteractionMetric, number>> {
    return Object.freeze(
      Object.fromEntries(
        INTERACTION_METRICS.map((metric) => [metric, this.#interactionCounters.get(metric) ?? 0]),
      ) as Record<InteractionMetric, number>,
    );
  }

  async start(): Promise<void> {
    if (!this.#config.enabled) return;
    // Prove the audit path before binding the socket; a non-awaitable or
    // failing writer must never leave a seemingly-ready gateway behind.
    await this.#audit.write(
      createSafeLogMetadata({ operation: 'startup', outcome: 'allowed', reasonCode: 'accepted' }),
    );
    await this.#server.start();
  }

  async createSession(
    claims: GatewayAssertionClaims,
    options?: Omit<GatewaySessionCompositionOptions, 'binding' | 'providerBroker' | 'providerProbe'>,
    correlationId?: string,
  ): Promise<ReturnType<typeof composeGatewaySession> | ServerSession> {
    this.#lifecycle.assertAccepting();
    if (!this.#config.enabled) throw new GatewayStartupError();
    const binding = this.#admission.admit(claims);
    if (this.#config.runtimeFactory) {
      const { session } = await this.#composeRuntimeBackedSession(binding, {
        auditOperation: 'session_create',
        ownedBinding: true,
        correlationId,
      });
      return session;
    }
    return this.#composeLegacyFixtureSession(claims, options, binding);
  }

  /**
   * Compose a live runtime-backed session through the RuntimeFactory: open (or
   * reuse) the persistence handle, create the runtime, then attach the shared
   * gateway wiring (dispose hooks, lifecycle registration, event and
   * background-subagent sinks). Fresh sessions and restart-restored sessions
   * take the same path; a restored session additionally hydrates its history
   * from the persisted transcript before the runtime becomes reachable.
   */
  async #composeRuntimeBackedSession(
    binding: SessionBinding,
    options: {
      auditOperation: 'session_create' | 'session_resume';
      ownedBinding: boolean;
      correlationId?: string;
      hydrate?: (session: ServerSession) => void;
      /** Pre-resolved snapshot (restore path). When absent, the launcher's current snapshot is captured and persisted. */
      snapshot?: SessionSettingsSnapshot;
    },
  ): Promise<{ session: ServerSession; persisted: GatewayPersistedSession | undefined }> {
    const runtimeFactory = this.#config.runtimeFactory;
    if (!runtimeFactory) throw new GatewayStartupError();
    const authority = runtimeFactory.settingsAuthority;
    // A restored session runs on its persisted snapshot; a fresh session
    // captures the launcher's current one. Either way the factory receives an
    // explicit snapshot so it can never silently re-read a changed default.
    const runtimeSnapshot =
      options.snapshot ??
      (authority
        ? createSessionSettingsSnapshot({ settings: authority, effectiveToolPolicy: { allowWrite: false } })
        : undefined);
    let persisted: GatewayPersistedSession | undefined = this.#persisted.get(binding.sessionId);
    let createdSession: ServerSession | undefined;
    try {
      if (!persisted) {
        persisted = await this.#config.persistence?.open(binding);
      }
      const session = await runtimeFactory.create(binding, {
        settingsSnapshot: runtimeSnapshot,
        eventSink: (event, context) => {
          if (context.turnId) this.#lastTurnIds.set(binding.sessionId, context.turnId);
          if (event.type === 'subagent_started' && event.agentId && context.turnId)
            this.#childTurnIds.set(event.agentId, context.turnId);
          if (event.type === 'subagent_approval_required') this.#childRoles.set(event.agentId, event.role);
          const persistence = this.#persistConversationEvent(binding.sessionId, event, context);
          if (isCriticalRuntimeEvent(event)) return persistence;
          // Streaming deltas remain observationally non-blocking, but their
          // persistence failure must be consumed so it cannot become an
          // unhandled rejection. A later critical event observes the
          // journal's failure latch and is awaited by the runtime.
          void persistence.catch(() => undefined);
          return undefined;
        },
      });
      createdSession = session;
      options.hydrate?.(session);
      if (runtimeSnapshot && !options.snapshot && persisted) {
        // Session-creation durability: a session must not become reachable
        // unless its provider/model identity is durably recorded, or a restart
        // could silently substitute the launcher's current default. Failure
        // rolls the whole composition back in the catch below.
        try {
          await writeSessionSnapshot(persisted.persistence.directory, {
            schemaVersion: 1,
            providerId: runtimeSnapshot.providerId,
            modelId: runtimeSnapshot.modelId,
            reasoningEffort: runtimeSnapshot.reasoningEffort,
          });
        } catch {
          throw new GatewayPersistenceError(
            'snapshot_unwritable',
            'session provider/model snapshot could not be persisted',
          );
        }
      }
      if (persisted) {
        this.#persisted.set(binding.sessionId, persisted);
        session.addDisposeHook(async () => {
          await persisted!.persistence.close();
          this.#persisted.delete(binding.sessionId);
          this.#interactionBindings.delete(binding.sessionId);
          this.#lastTurnIds.delete(binding.sessionId);
          await this.#config.persistence?.close(binding.sessionId, this.#shutdownInProgress ? 'interrupted' : 'closed');
        });
      }
      const release = this.#lifecycle.registerWorker({ close: () => session.dispose() });
      session.addDisposeHook(() => {
        release();
        this.#admission.remove(binding.sessionId);
        this.#sessions.delete(binding.sessionId);
        this.#persisted.delete(binding.sessionId);
        this.#interactionBindings.delete(binding.sessionId);
      });
      this.#sessions.set(binding.sessionId, session);
      session.service.setBackgroundSubagentEventSink((event) => {
        const agentId =
          event.type === 'subagent_question'
            ? event.runId
            : event.type === 'subagent_completed'
            ? event.result.agentId
            : (event as { agentId?: string }).agentId;
        if (event.type === 'subagent_started' && event.agentId && session.activeTurnId) {
          this.#childTurnIds.set(event.agentId, session.activeTurnId);
          this.#childRoles.set(event.agentId, event.role);
        }
        const turnId = agentId
          ? this.#childTurnIds.get(agentId) ?? session.activeTurnId ?? this.#lastTurnIds.get(binding.sessionId)
          : session.activeTurnId ?? this.#lastTurnIds.get(binding.sessionId);
        if (turnId) void this.#persistConversationEvent(binding.sessionId, event, { turnId, discardedTurnIds: [] });
      });
      session.service.backgroundSubagentApprovals.subscribe(() => {
        const current = session.service.backgroundSubagentApprovals.getSnapshot().current;
        if (!current) return;
        const turnId = this.#childTurnIds.get(current.runId);
        if (!turnId) return;
        void this.#persistConversationEvent(
          binding.sessionId,
          {
            type: 'subagent_approval_required',
            agentId: current.runId,
            role: this.#childRoles.get(current.runId) ?? 'subagent',
          },
          { turnId, discardedTurnIds: [] },
        );
      });
      await this.#audit.write(
        createSafeLogMetadata({
          operation: options.auditOperation,
          outcome: 'allowed',
          reasonCode: 'accepted',
          sessionId: binding.sessionId,
          workspaceId: binding.workspaceId,
          grantVersion: binding.grantVersion,
          access: binding.access,
          ...(options.correlationId ? { correlationId: options.correlationId } : {}),
        }),
      );
      return { session, persisted };
    } catch (error) {
      // The runtime was created but the composition failed (snapshot
      // durability, hydration, ...): dispose it before the persistence it
      // may still write to.
      if (createdSession) {
        try {
          await createdSession.dispose();
        } catch {
          // Preserve the original composition failure.
        }
      }
      // Roll the persistence handle back whoever opened it — composition
      // opened it, or #ensurePersistedSession installed it before the failed
      // restore. A failed restore must not leave an open handle in #persisted;
      // the read path and the next revival reopen on demand.
      if (persisted) {
        try {
          await persisted.persistence.close();
          await this.#config.persistence?.close(binding.sessionId, 'interrupted');
        } catch {
          // Preserve the original composition failure; persistence keeps its evidence.
        }
        this.#persisted.delete(binding.sessionId);
      }
      if (options.ownedBinding) this.#admission.remove(binding.sessionId);
      throw error;
    }
  }

  /**
   * Lazily revive a persisted session whose runtime died with a previous
   * gateway process. Returns the live runtime, a specific gateway error for a
   * refused revival (revoked grant, unavailable provider or model, resource
   * limits), or null when there is nothing this gateway can restore — callers
   * keep their legacy not-found/not-admitting behavior for null. Concurrent
   * first revivals of one session share a single creation promise.
   */
  async #ensureLiveRuntime(
    ownerUserId: string,
    sessionId: string,
    correlationId?: string,
  ): Promise<{ session: ServerSession; persisted: GatewayPersistedSession } | GatewayRpcResult | null> {
    const existing = this.#sessions.get(sessionId);
    const existingPersisted = this.#persisted.get(sessionId);
    if (existing instanceof ServerSession) {
      // Owner scoping holds on every return path, live or restored: a session
      // owned by someone else does not exist for this caller.
      if (existing.binding.ownerUserId !== ownerUserId) return publicError(404, 'not_found', 'session not found');
      if (existingPersisted) return { session: existing, persisted: existingPersisted };
    }
    if (!this.#config.runtimeFactory || !this.#config.persistence) return null;
    // A persisted session owned by another caller is a 404 for this caller,
    // not the legacy fallback: the index is owner-scoped for a reason. This
    // also stops a foreign caller from latching onto an in-flight revival.
    let foreign: GatewaySessionRecord | null;
    try {
      foreign = this.#config.persistence.index.get(sessionId);
    } catch {
      foreign = null;
    }
    if (foreign && foreign.ownerUserId !== ownerUserId) return publicError(404, 'not_found', 'session not found');
    const restoreKey = `${ownerUserId}\u0000${sessionId}`;
    const guardOwner = (
      result: { session: ServerSession; persisted: GatewayPersistedSession } | GatewayRpcResult | null,
    ): { session: ServerSession; persisted: GatewayPersistedSession } | GatewayRpcResult | null => {
      if (result && 'session' in result && result.session.binding.ownerUserId !== ownerUserId)
        return publicError(404, 'not_found', 'session not found');
      return result;
    };
    const inflight = this.#sessionRestores.get(restoreKey);
    if (inflight) return inflight.then(guardOwner);
    const restore = this.#restoreRuntime(ownerUserId, sessionId, correlationId);
    this.#sessionRestores.set(restoreKey, restore);
    restore.then(
      () => {
        if (this.#sessionRestores.get(restoreKey) === restore) this.#sessionRestores.delete(restoreKey);
      },
      () => {
        // A rejected revival must clear the single-flight entry too, or the
        // session would stay wedged forever; everyone awaiting the shared
        // promise already holds the rejection, so swallow it here.
        if (this.#sessionRestores.get(restoreKey) === restore) this.#sessionRestores.delete(restoreKey);
      },
    );
    return restore.then(guardOwner);
  }

  async #restoreRuntime(
    ownerUserId: string,
    sessionId: string,
    correlationId?: string,
  ): Promise<{ session: ServerSession; persisted: GatewayPersistedSession } | GatewayRpcResult | null> {
    try {
      const index = this.#config.persistence!.index;
      let record: ReturnType<typeof index.getForOwner>;
      try {
        record = index.getForOwner(ownerUserId, sessionId);
      } catch (error) {
        if (error instanceof GatewayPersistenceError && error.code === 'not_found') return null;
        throw error;
      }
      if (record.status === 'closed') return null;
      const grantVersion = Number(record.grantVersion);
      if (!Number.isSafeInteger(grantVersion))
        throw new GatewayPersistenceError('readonly', 'session grant version is invalid');
      // The admission layer is the grant authority: manifest and restored
      // dynamic grants, enabled state, and the workspace boundary probe all
      // revalidate before any runtime exists. A revoked grant fails here with
      // a typed admission error instead of a generic not-found.
      const binding = this.#admission.restore(sessionId, ownerUserId, record.workspaceId, grantVersion);
      const persisted = await this.#ensurePersistedSession(ownerUserId, sessionId);
      const snapshot = await this.#restoredSessionSnapshot(persisted);
      if (snapshot && 'body' in snapshot) return snapshot;
      const unavailable = await this.#sessionSnapshotUnavailable(snapshot);
      if (unavailable) return unavailable;
      if (this.#lifecycle.state !== 'running')
        return publicError(503, 'gateway_unavailable', 'gateway is not accepting sessions', true);
      const directory = this.#config.persistence?.layout.existingSessionPath(
        binding.ownerUserId,
        binding.workspaceId,
        binding.sessionId,
      );
      const composed = await this.#composeRuntimeBackedSession(binding, {
        auditOperation: 'session_resume',
        ownedBinding: false,
        correlationId,
        snapshot,
        hydrate: (session) => {
          if (directory) hydrateConversationService(session.service, directory, binding.sessionId);
          // Revival is complete: the coarse index lifecycle returns to the
          // resting state a fresh session holds; live turn state stays in the
          // ServerSession. The interrupted turn stays interrupted in the
          // journal; the next turn is a normal turn.
          this.#config.persistence?.index.update(binding.sessionId, {
            status: 'idle',
            interruptedAt: null,
            recoveryWarning: null,
          });
        },
      });
      return { session: composed.session, persisted };
    } catch (error) {
      return this.#mapError(error);
    }
  }

  /**
   * The snapshot a restored session must come back on: the per-session
   * provider/model recorded when the session was created. Sessions created
   * before that record existed (or whose record is unreadable) fall back to
   * the launcher's current snapshot; the fallback is documented and is still
   * validated below, so it is never a silent substitution of an unavailable
   * provider or model. Only the production stack (settings authority) has a
   * snapshot to restore against; fixture gateways compose without one.
   */
  async #restoredSessionSnapshot(
    persisted: GatewayPersistedSession,
  ): Promise<SessionSettingsSnapshot | undefined | GatewayRpcResult> {
    const settings = this.#config.runtimeFactory?.settingsAuthority;
    if (!settings) return undefined;
    const stored = await readSessionSnapshot(persisted.persistence.directory);
    // Absent is the documented pre-change compatibility state; a record that
    // exists but cannot be trusted is corruption and is refused — falling
    // back would silently change the session's provider/model identity.
    if (stored.state === 'corrupt')
      return publicError(500, 'session_snapshot_invalid', 'persisted session snapshot is unreadable or malformed');
    if (stored.state === 'absent')
      return createSessionSettingsSnapshot({ settings, effectiveToolPolicy: { allowWrite: false } });
    return createSessionSettingsSnapshot({
      settings,
      providerId: stored.snapshot.providerId,
      modelId: stored.snapshot.modelId,
      reasoningEffort: stored.snapshot.reasoningEffort,
      effectiveToolPolicy: { allowWrite: false },
    });
  }
  /**
   * A restored session replays into the runtime built from its snapshot.
   * Refuse instead of silently substituting when that snapshot's provider or
   * model is no longer available. Only the production stack (settings
   * authority + model catalog) can answer this; fixture gateways skip the
   * check.
   */
  async #sessionSnapshotUnavailable(snapshot: SessionSettingsSnapshot | undefined): Promise<GatewayRpcResult | null> {
    const settings = this.#config.runtimeFactory?.settingsAuthority;
    const catalog = this.#modelCatalog;
    if (!settings || !catalog || !snapshot) return null;
    const providerId = String(snapshot.providerId);
    if (!getAvailableProviderIds(settings, getProviderIds()).includes(providerId))
      return publicError(409, 'provider_unavailable', 'session provider is no longer available');
    let models;
    try {
      ({ models } = await catalog.load(providerId));
    } catch {
      return publicError(503, 'model_catalog_unavailable', 'model catalog unavailable', true);
    }
    if (!models.some((model) => model.id === snapshot.modelId))
      return publicError(409, 'model_unavailable', 'session model is no longer available');
    return null;
  }

  /** Legacy fixture composition without the production runtime factory. */
  async #composeLegacyFixtureSession(
    _claims: GatewayAssertionClaims,
    options: Omit<GatewaySessionCompositionOptions, 'binding' | 'providerBroker' | 'providerProbe'> | undefined,
    binding: SessionBinding,
    correlationId?: string,
  ): Promise<ReturnType<typeof composeGatewaySession>> {
    const providerProbe = this.#config.providerProbe;
    if (!providerProbe) throw new GatewayStartupError();
    const providerBroker = assertProviderBrokerReady(this.#config.providerBroker, providerProbe);
    const session = composeGatewaySession({
      binding,
      providerBroker,
      providerProbe,
      tmpDir: options?.tmpDir ?? this.#config.tmpDir!,
      env: options?.env,
      sandboxAvailable: options?.sandboxAvailable ?? this.#config.workerSandboxAvailable,
      createRuntime: options?.createRuntime,
    });
    const release = this.#lifecycle.registerWorker({ close: () => session.dispose() });
    const originalDispose = session.dispose;
    session.dispose = () => {
      release();
      originalDispose();
      this.#admission.remove(binding.sessionId);
      this.#sessions.delete(binding.sessionId);
    };
    this.#sessions.set(binding.sessionId, session);
    await this.#audit.write(
      createSafeLogMetadata({
        operation: 'session_create',
        outcome: 'allowed',
        reasonCode: 'accepted',
        sessionId: binding.sessionId,
        workspaceId: binding.workspaceId,
        grantVersion: binding.grantVersion,
        access: binding.access,
        ...(correlationId ? { correlationId } : {}),
      }),
    );
    return session;
  }

  async shutdown(graceMs = 5_000): Promise<void> {
    if (this.#shutdownPromise) return this.#shutdownPromise;
    this.#shutdownInProgress = true;
    const hardDeadlineMs = Math.max(1, graceMs);
    this.#shutdownPromise = (async () => {
      const deadline = Date.now() + hardDeadlineMs;
      let forced = false;
      const remaining = () => Math.max(1, deadline - Date.now());
      const waitBounded = async (work: Promise<unknown>): Promise<boolean> => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const completed = await Promise.race([
          work.then(
            () => true,
            () => true,
          ),
          new Promise<boolean>((resolve) => {
            timer = setTimeout(() => resolve(false), remaining());
          }),
        ]);
        if (timer) clearTimeout(timer);
        return completed;
      };
      const markForced = () => {
        if (forced) return;
        forced = true;
        for (const sessionId of this.#persisted.keys()) this.#config.persistence?.markForcedShutdown(sessionId);
      };

      if (!(await waitBounded(this.#server.shutdown(remaining())))) markForced();
      if (
        !(await waitBounded(
          Promise.all([...this.#sessions.values()].map((session) => Promise.resolve(session.dispose()))),
        ))
      )
        markForced();
      if (this.#config.runtimeFactory && !(await waitBounded(this.#config.runtimeFactory.shutdown(remaining()))))
        markForced();
      this.#sessions.clear();
      // Close persistence handles that outlived their session: read-path opens
      // and compositions that failed before installing a dispose hook would
      // otherwise keep file descriptors and locks past shutdown.
      for (const [sessionId, persisted] of this.#persisted) {
        try {
          await waitBounded(persisted.persistence.close());
          await waitBounded(this.#config.persistence?.close(sessionId, 'interrupted') ?? Promise.resolve());
        } catch {
          // Shutdown proceeds; the interrupted status is recorded in the index.
        }
      }
      this.#persisted.clear();
      this.#replay.close();
      // The audit record is bounded by the same deadline. A broken audit sink
      // must not keep the local owner process alive indefinitely.
      await waitBounded(
        this.#audit.write(
          createSafeLogMetadata({
            operation: 'shutdown',
            outcome: forced ? 'interrupted' : 'allowed',
            reasonCode: forced ? 'forced_shutdown' : 'shutdown',
          }),
        ),
      );
    })();
    return this.#shutdownPromise;
  }
}

type InteractionBinding = {
  publicInteractionId: string;
  expectedInteractionId: number;
  continuationGeneration: string;
  revision: number;
  turnId: string;
  variant: string;
  dto: InteractionDto;
  owner: 'root' | 'background_approval' | 'background_question';
  childRunId?: string;
  childMessageId?: string;
  childRole?: string;
  backgroundEntry?: { runId: string; generation: number; toolCallId: string; toolName: string; argumentsText: string };
  backgroundRevision?: number;
};

type PrivateRoute = {
  purpose: GatewayAssertionClaims['purpose'];
  legacy?: boolean;
  sessionId?: string;
  interactionId?: string;
};

function matchPrivateRoute(method: string, pathname: string): PrivateRoute | null {
  if (method === 'POST' && pathname === '/') return { purpose: 'session_create', legacy: true };
  // GET is canonical for workspace_list; POST is a tested compatibility alias for the pinned BFF wire.
  if ((method === 'GET' || method === 'POST') && pathname === '/private/agent/v1/workspaces')
    return { purpose: 'workspace_list' };
  if (method === 'POST' && pathname === '/private/agent/v1/workspace/candidates/validate')
    return { purpose: 'workspace_candidate_validate' };
  if (method === 'POST' && pathname === '/private/agent/v1/workspace/candidates/browse')
    return { purpose: 'workspace_candidate_browse' };
  if (method === 'POST' && pathname === '/private/agent/v1/workspace/candidates/select')
    return { purpose: 'workspace_candidate_select' };
  if (method === 'GET' && pathname === '/private/agent/v1/models') return { purpose: 'model_list' };
  if (method === 'GET' && pathname === '/private/agent/v1/settings') return { purpose: 'settings_read' };
  if (method === 'PUT' && pathname === '/private/agent/v1/settings') return { purpose: 'settings_write' };
  const credential = pathname.match(/^\/private\/agent\/v1\/credentials\/([A-Za-z0-9_-]{1,256})$/);
  if (credential && method === 'POST') return { purpose: 'credential_write', interactionId: credential[1] };
  if (credential && method === 'DELETE') return { purpose: 'credential_delete', interactionId: credential[1] };
  const oauth = pathname.match(/^\/private\/agent\/v1\/oauth\/([A-Za-z0-9_-]{1,256})\/(login|select)$/);
  if (oauth && method === 'POST')
    return {
      purpose: oauth[2] === 'login' ? 'oauth_login' : 'oauth_select',
      interactionId: `${oauth[1]}\u0000${oauth[2]}`,
    };
  const oauthDelete = pathname.match(
    /^\/private\/agent\/v1\/oauth\/([A-Za-z0-9_-]{1,256})\/accounts\/([A-Za-z0-9_-]{1,256})$/,
  );
  if (oauthDelete && method === 'DELETE')
    return { purpose: 'oauth_delete', interactionId: `${oauthDelete[1]}\u0000${oauthDelete[2]}` };
  if (method === 'POST' && pathname === '/private/agent/v1/sessions') return { purpose: 'session_create' };
  if (method === 'GET' && pathname === '/private/agent/v1/sessions') return { purpose: 'session_list' };
  const match = pathname.match(
    /^\/private\/agent\/v1\/sessions\/([A-Za-z0-9_-]{1,256})(?:\/(messages|abort|events|config|commands|interactions\/([A-Za-z0-9_-]{1,256})))?$/,
  );
  if (!match) return null;
  const sessionId = match[1]!;
  if (method === 'POST' && !match[2]) return { purpose: 'session_read', sessionId };
  if (method === 'POST' && match[2] === 'messages') return { purpose: 'message_submit', sessionId };
  if (method === 'POST' && match[2] === 'abort') return { purpose: 'abort', sessionId };
  if (method === 'GET' && match[2] === 'events') return { purpose: 'events_connect', sessionId };
  if (method === 'POST' && match[2] === 'config') return { purpose: 'session_update', sessionId };
  if (method === 'POST' && match[2] === 'commands') return { purpose: 'command_invoke', sessionId };
  if (method === 'POST' && match[2]?.startsWith('interactions/'))
    return { purpose: 'interaction_resolve', sessionId, interactionId: match[3] };
  return null;
}

function deriveDynamicWorkspaceRoots(manifest: GatewayManifest): string[] {
  const roots = new Set<string>();
  for (const grant of manifest.grants) {
    if (grant.kind !== 'local' || !grant.localRoot) continue;
    try {
      const canonical = realpathSync(grant.localRoot);
      if (statSync(canonical).isDirectory()) roots.add(canonical);
    } catch {
      // A stale manifest root remains a v1 admission error; it must not make
      // the otherwise-compatible gateway fail before the candidate route is used.
    }
  }
  return [...roots];
}

export function classifyInteractionResolution(
  interaction: SessionProjectionSource['interaction'],
  hasLiveSnapshot: boolean,
): 'interaction_not_resolvable' | 'interaction_already_resolved' | null {
  if (hasLiveSnapshot) return null;
  if (interaction?.state === 'recovered') return 'interaction_not_resolvable';
  return 'interaction_already_resolved';
}

function hasDeferredModelSelectionField(body: unknown): boolean {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  return Object.keys(body as Record<string, unknown>).some((key) => ['model', 'reasoningEffort', 'mode'].includes(key));
}

function isSessionCreateBody(body: unknown, workspaceId: string | undefined, legacy = false): boolean {
  if (legacy && body === null) return true;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const keys = Object.keys(body as Record<string, unknown>);
  if (keys.some((key) => key !== 'workspaceId')) return false;
  const requested = (body as Record<string, unknown>).workspaceId;
  return typeof requested === 'string' && requested === workspaceId;
}

function isWorkspaceCandidateValidateBody(body: unknown): body is { absolutePath: string } {
  return (
    !!body &&
    typeof body === 'object' &&
    !Array.isArray(body) &&
    Object.keys(body as Record<string, unknown>).length === 1 &&
    typeof (body as Record<string, unknown>).absolutePath === 'string'
  );
}

function isWorkspaceCandidateBrowseBody(body: unknown): body is { candidateId: string; child?: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const value = body as Record<string, unknown>;
  return (
    Object.keys(value).every((key) => key === 'candidateId' || key === 'child') &&
    isOpaqueId(value.candidateId) &&
    (value.child === undefined || isOpaqueId(value.child))
  );
}

function isWorkspaceCandidateSelectBody(body: unknown): body is {
  candidateId: string;
  access: 'read' | 'read_write';
} {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const value = body as Record<string, unknown>;
  return (
    Object.keys(value).length === 2 &&
    Object.keys(value).every((key) => key === 'candidateId' || key === 'access') &&
    isOpaqueId(value.candidateId) &&
    (value.access === 'read' || value.access === 'read_write')
  );
}

function isSettingsWriteBody(
  body: unknown,
): body is { expectedRevision: string; changes: Array<{ key: string; value: unknown }> } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const value = body as Record<string, unknown>;
  if (typeof value.expectedRevision !== 'string' || !Array.isArray(value.changes) || value.changes.length > 100)
    return false;
  return value.changes.every((change) => {
    if (!change || typeof change !== 'object' || Array.isArray(change)) return false;
    const item = change as Record<string, unknown>;
    return (
      Object.keys(item).length === 2 &&
      typeof item.key === 'string' &&
      Object.prototype.hasOwnProperty.call(item, 'value') &&
      isSafeSettingsValue(item.value)
    );
  });
}

function isPairingRegisterBody(body: unknown): body is { publicKeyPem: string; otp: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const value = body as Record<string, unknown>;
  return (
    Object.keys(value).length === 2 &&
    typeof value.publicKeyPem === 'string' &&
    value.publicKeyPem.length > 0 &&
    value.publicKeyPem.length <= 16_384 &&
    typeof value.otp === 'string' &&
    /^\d{6}$/.test(value.otp)
  );
}

function isSafeSettingsValue(value: unknown): boolean {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    (Array.isArray(value) && value.every((item) => typeof item === 'string'))
  );
}

function isCredentialWriteBody(body: unknown): body is { value: string } {
  return (
    !!body &&
    typeof body === 'object' &&
    !Array.isArray(body) &&
    Object.keys(body as Record<string, unknown>).length === 1 &&
    typeof (body as Record<string, unknown>).value === 'string' &&
    ((body as Record<string, unknown>).value as string).length > 0
  );
}

function isOAuthSelectBody(body: unknown): body is { accountId: string } {
  return (
    !!body &&
    typeof body === 'object' &&
    !Array.isArray(body) &&
    Object.keys(body as Record<string, unknown>).length === 1 &&
    isOpaqueId((body as Record<string, unknown>).accountId)
  );
}

function isSessionUpdateBody(body: unknown): body is { model?: string; reasoningEffort?: string; mode?: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const value = body as Record<string, unknown>;
  if (Object.keys(value).some((key) => !['model', 'reasoningEffort', 'mode'].includes(key))) return false;
  if (
    value.model !== undefined &&
    (typeof value.model !== 'string' || value.model.length === 0 || value.model.length > 512)
  )
    return false;
  if (
    value.reasoningEffort !== undefined &&
    !['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(String(value.reasoningEffort))
  )
    return false;
  return (
    value.mode === undefined || ['standard', 'lite', 'plan', 'mentor', 'orchestrator'].includes(String(value.mode))
  );
}

export function sessionConfigProjection(session: ServerSession): Record<string, unknown> {
  const snapshot = session.resources.settings;
  const service = session.resources.sessionSettingsService;
  const get = (key: string, fallback: unknown) => service?.getDynamic(key) ?? fallback;
  const snapshotPolicy = snapshot.toolPolicy ?? {};
  const sessionPolicy = session.resources.settings.toolPolicy ?? {};
  const activeProfileId = get('app.activeProfileId', undefined);
  const modeByProfileId: Record<string, string> = {
    'builtin:standard': 'standard',
    'builtin:lite': 'lite',
    'builtin:plan': 'plan',
    'builtin:mentor': 'mentor',
    'builtin:orchestrator': 'orchestrator',
  };
  const toolPolicy = {
    allowWrite: sessionPolicy.allowWrite ?? snapshotPolicy.allowWrite ?? false,
    autoApprove: sessionPolicy.autoApprove ?? snapshotPolicy.autoApprove ?? false,
    allowUnsandboxed: sessionPolicy.allowUnsandboxed ?? snapshotPolicy.allowUnsandboxed ?? false,
    sshEnabled: sessionPolicy.sshEnabled ?? snapshotPolicy.sshEnabled ?? false,
  };
  const settings = {
    providerId: get('agent.provider', snapshot.providerId),
    modelId: get('agent.model', snapshot.modelId),
    reasoningEffort: get('agent.reasoningEffort', snapshot.reasoningEffort ?? 'default'),
    mode:
      (activeProfileId === undefined ? undefined : modeByProfileId[String(activeProfileId)]) ??
      snapshot.mode ??
      'standard',
    toolPolicy,
    defaultsRevision: snapshot.defaultsRevision,
  };
  return {
    sessionId: session.sessionId,
    providerId: settings.providerId ?? 'unknown',
    modelId: settings.modelId ?? 'unknown',
    reasoningEffort: settings.reasoningEffort ?? 'default',
    mode: settings.mode ?? 'standard',
    toolPolicy,
    configRevision: crypto.createHash('sha256').update(JSON.stringify(settings)).digest('hex'),
    defaultsRevision: settings.defaultsRevision ?? 'unknown',
  };
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(value);
}

function hasAttachments(body: unknown): boolean {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  return Object.keys(body as Record<string, unknown>).some((key) =>
    ['images', 'attachments', 'attachmentIds'].includes(key),
  );
}

function isMessageBody(body: unknown): body is { text: string; clientRequestId: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const value = body as Record<string, unknown>;
  return (
    Object.keys(value).every((key) => key === 'text' || key === 'clientRequestId') &&
    typeof value.text === 'string' &&
    value.text.length > 0 &&
    value.text.length <= 128_000 &&
    isOpaqueId(value.clientRequestId)
  );
}

function isTurnBody(body: unknown): body is { turnId: string } {
  return (
    !!body &&
    typeof body === 'object' &&
    !Array.isArray(body) &&
    Object.keys(body as Record<string, unknown>).length === 1 &&
    isOpaqueId((body as Record<string, unknown>).turnId)
  );
}

const COMMAND_ALLOWLIST = new Set(['compact', 'retry-tool', 'retry-turn']);

function isCommandBody(body: unknown): body is { commandId: string; clientRequestId: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const value = body as Record<string, unknown>;
  return (
    Object.keys(value).length === 2 &&
    typeof value.commandId === 'string' &&
    value.commandId.length > 0 &&
    value.commandId.length <= 256 &&
    isOpaqueId(value.clientRequestId)
  );
}

export type InteractionResolveRequest = {
  revision: number;
  answer: string;
  rejectionReason?: string;
  approvalAnswer?: string;
};

export function isInteractionResolveRequest(body: unknown): body is InteractionResolveRequest {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const value = body as Record<string, unknown>;
  return (
    Object.keys(value).every((key) => ['revision', 'answer', 'rejectionReason', 'approvalAnswer'].includes(key)) &&
    typeof value.revision === 'number' &&
    Number.isSafeInteger(value.revision) &&
    value.revision >= 1 &&
    typeof value.answer === 'string' &&
    value.answer.length <= 16_384 &&
    (value.rejectionReason === undefined || typeof value.rejectionReason === 'string') &&
    (value.approvalAnswer === undefined || typeof value.approvalAnswer === 'string')
  );
}

function parseQueryLimit(value: string | null): number | undefined {
  if (value === null) return undefined;
  if (!/^[0-9]{1,3}$/.test(value)) throw new GatewayPersistenceError('cursor_invalid', 'limit is invalid');
  return Number(value);
}

function parseEventCursor(value: string | null): { value: number | null; error?: 'cursor_invalid' } {
  if (value === null) return { value: null };
  if (!/^(?:0|[1-9][0-9]{0,14})$/.test(value)) return { value: null, error: 'cursor_invalid' };
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? { value: parsed } : { value: null, error: 'cursor_invalid' };
}

function publicError(
  status: number,
  code: string,
  message: string,
  retryable?: boolean,
  details?: Record<string, unknown>,
): GatewayRpcResult {
  return {
    status,
    body: {
      error: { code, message, ...(retryable === undefined ? {} : { retryable }), ...(details ? { details } : {}) },
    },
  };
}

function isPublicEventEnvelope(event: import('./persistence/contracts.js').AgentEventEnvelope): boolean {
  if (
    event.schemaVersion !== 1 ||
    !Number.isSafeInteger(event.id) ||
    !isOpaqueId(event.sessionId) ||
    !(FROZEN_AGENT_EVENT_TYPES as readonly string[]).includes(event.type) ||
    typeof event.occurredAt !== 'string' ||
    !event.payload ||
    typeof event.payload !== 'object' ||
    Array.isArray(event.payload)
  )
    return false;
  try {
    if (
      event.type === 'approval_required' ||
      event.type === 'interaction_updated' ||
      event.type === 'interaction_recovered' ||
      event.type === 'subagent_approval_required' ||
      event.type === 'subagent_question'
    ) {
      if (
        !event.payload.interaction ||
        typeof event.payload.interaction !== 'object' ||
        !validatePendingInteractionDto(event.payload.interaction)
      )
        return false;
      if (
        event.type === 'interaction_recovered' &&
        !['daemon_restart', 'forced_shutdown', 'persistence_recovery'].includes(String(event.payload.reason))
      )
        return false;
    }
    if (event.type === 'interaction_resolved') {
      const keys = Object.keys(event.payload).sort();
      if (keys.join(',') !== 'interactionId,outcome,turnId,variant') return false;
      if (
        !isOpaqueId(event.payload.interactionId) ||
        !['approved', 'rejected', 'cancelled', 'continued'].includes(String(event.payload.outcome))
      )
        return false;
    }
  } catch {
    return false;
  }
  const visit = (value: unknown, depth = 0): boolean => {
    if (depth > 8) return false;
    if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
      return typeof value !== 'string' || value.length <= 32_000;
    if (Array.isArray(value)) return value.length <= 512 && value.every((item) => visit(item, depth + 1));
    if (typeof value !== 'object') return false;
    return Object.entries(value).every(([key, child]) => PUBLIC_EVENT_PAYLOAD_KEYS.has(key) && visit(child, depth + 1));
  };
  return visit(event.payload);
}

function boundedText(value: unknown, max = 8_192): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function safeCounter(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.min(Math.floor(value), Number.MAX_SAFE_INTEGER)
    : 0;
}

function boundedInteger(value: unknown, max: number): number {
  const number = safeCounter(value);
  return Math.min(number, max);
}

function normalizedUsagePayload(usage: {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}): Record<string, number> {
  const inputTokens = safeCounter(usage.prompt_tokens);
  const outputTokens = safeCounter(usage.completion_tokens);
  return { inputTokens, outputTokens, totalTokens: safeCounter(usage.total_tokens) || inputTokens + outputTokens };
}

function commandStatus(value: unknown): 'pending' | 'running' | 'completed' | 'failed' | 'aborted' | null {
  switch (value) {
    case 'pending':
    case 'running':
      return value;
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'cancelled':
    case 'interrupted':
    case 'aborted':
      return 'aborted';
    case 'backgrounded':
      return 'running';
    default:
      return null;
  }
}

function commandMessagePayload(input: unknown): Record<string, unknown> | null {
  const message = input as Record<string, unknown>;
  const callId = typeof message.callId === 'string' ? message.callId : '';
  const toolName = typeof message.toolName === 'string' ? message.toolName : '';
  const status = commandStatus(message.status);
  if (!callId || !toolName || !status) {
    malformedCommandMessageDrops = Math.min(malformedCommandMessageDrops + 1, 1_000_000);
    return null;
  }
  return {
    callId: boundedText(callId, 256),
    toolName: boundedText(toolName, 256),
    status,
    ...(typeof message.output === 'string' ? { output: boundedText(message.output, 16_384) } : {}),
    ...(typeof message.failureReason === 'string' ? { error: boundedText(message.failureReason, 10_000) } : {}),
    message: {
      id: boundedText(message.id, 256),
      role: 'command',
      text: boundedText(message.command, 16_384),
    },
  };
}

export function publicEventProjectionCounters(): Readonly<{ malformedCommandMessageDrops: number }> {
  return Object.freeze({ malformedCommandMessageDrops });
}

function commandMessageCandidate(
  base: { sessionId: string; payload: Record<string, unknown>; type?: string },
  message: unknown,
  type: 'command_message' | 'subagent_command_message',
): import('./persistence/contracts.js').DurableEventCandidate | null {
  const projected = commandMessagePayload(message);
  if (!projected) return null;
  return {
    ...base,
    type,
    payload: { ...base.payload, ...projected },
  } as import('./persistence/contracts.js').DurableEventCandidate;
}

function errorReason(kind: string | undefined): string {
  switch (kind) {
    case 'provider':
      return 'provider_error';
    case 'network':
      return 'network_error';
    case 'rate_limit':
      return 'rate_limit';
    case 'authentication':
      return 'authentication_error';
    case 'cancelled':
      return 'cancelled';
    case 'validation':
      return 'validation_error';
    case 'compaction':
      return 'compaction_failed';
    case 'retry_exhausted':
      return 'retry_exhausted';
    case 'interaction_continuation_failed':
      return 'interaction_continuation_failed';
    default:
      return 'runtime_error';
  }
}

function interactionDtoFromApproval(
  approval: Record<string, unknown>,
  interactionId: string,
  revision: number,
): PendingInteractionDto {
  return projectPendingInteraction(approval, interactionId, revision);
}

function interactionDtoFromSnapshot(
  snapshot: {
    interactionId?: number;
    approval: unknown;
    askUserAnswers: readonly unknown[];
    currentAskUserQuestionIndex: number;
  },
  interactionId: string,
  revision: number,
): PendingInteractionDto {
  return projectPendingInteraction(
    snapshot.approval as Record<string, unknown>,
    interactionId,
    revision,
    snapshot.askUserAnswers,
    snapshot.currentAskUserQuestionIndex,
  );
}

function sanitizePublicInteraction(value: Record<string, unknown>): PendingInteractionDto {
  return validatePendingInteractionDto(value);
}

const PROJECTION_COMMAND_STATUSES = new Set(['completed', 'failed', 'aborted', 'unknown']);

function projectTranscriptMessages(
  transcript: SessionProjectionSource['transcript'],
  journalCommands: ReadonlyMap<string, readonly ProjectionCommand[]>,
): Record<string, unknown>[] {
  if (!transcript) return [];
  const commandsByTurn = new Map<string, ProjectionCommand[]>();
  const addCommand = (turnId: string, command: ProjectionCommand): void => {
    const commands = commandsByTurn.get(turnId) ?? [];
    if (!commands.some((candidate) => candidate.callId === command.callId)) commands.push(command);
    commandsByTurn.set(turnId, commands.slice(0, 64));
  };

  for (const command of transcript.toolLedger) {
    if (!PROJECTION_COMMAND_STATUSES.has(command.status)) continue;
    addCommand(command.turnId, {
      callId: boundedText(command.callId, 256),
      toolName: boundedText(command.toolName, 256),
      status: boundedText(command.status, 32) as ProjectionCommand['status'],
    });
  }
  for (const [turnId, commands] of journalCommands) {
    for (const command of commands) {
      const existing = commandsByTurn.get(turnId)?.find((candidate) => candidate.callId === command.callId);
      if (existing) {
        const current = commandsByTurn.get(turnId)!;
        commandsByTurn.set(
          turnId,
          current.map((candidate) => (candidate.callId === command.callId ? command : candidate)),
        );
      } else {
        addCommand(turnId, command);
      }
    }
  }

  const projected: Record<string, unknown>[] = [];
  let currentTurnId: string | null = null;
  const attachedTurns = new Set<string>();
  for (const message of transcript.messages) {
    const record = message as unknown as {
      id?: unknown;
      sender?: unknown;
      role?: unknown;
      text?: unknown;
      callId?: unknown;
      toolName?: unknown;
      status?: unknown;
    };
    const sender = typeof record.sender === 'string' ? record.sender : record.role;
    if (sender === 'user') {
      currentTurnId = typeof record.id === 'string' ? record.id : null;
    }
    if (sender === 'command' || sender === 'reasoning') {
      if (
        sender === 'command' &&
        currentTurnId &&
        typeof record.callId === 'string' &&
        typeof record.toolName === 'string' &&
        typeof record.status === 'string' &&
        !commandsByTurn.get(currentTurnId)?.some((command) => command.callId === record.callId)
      ) {
        addCommand(currentTurnId, {
          callId: boundedText(record.callId, 256),
          toolName: boundedText(record.toolName, 256),
          status: boundedText(record.status, 32) as ProjectionCommand['status'],
        });
      }
      continue;
    }

    const role = sender === 'user' ? 'user' : 'bot';
    const projectedMessage: Record<string, unknown> = {
      id: boundedText(record.id, 256),
      role,
      text: boundedText(record.text, 16_384),
    };
    const commands = role === 'bot' && currentTurnId ? commandsByTurn.get(currentTurnId) : undefined;
    if (commands && commands.length > 0 && !attachedTurns.has(currentTurnId!)) {
      projectedMessage.commands = commands;
      attachedTurns.add(currentTurnId!);
    }
    projected.push(projectedMessage);
  }
  return projected.slice(-200);
}

/**
 * Session transcript wire shape: messages have `id`, `role` (`user` or `bot`),
 * and bounded `text`. A completed turn's first bot message may carry a bounded
 * `commands` array of `{callId, toolName, status}` entries for its tool cards.
 */
function toSessionProjection(source: SessionProjectionSource): Record<string, unknown> {
  const transcript = source.transcript;
  const messages = projectTranscriptMessages(transcript, source.journalCommands);
  const interaction = source.interaction
    ? {
        ...source.interaction,
        interaction: sanitizePublicInteraction(source.interaction.interaction),
      }
    : null;
  return {
    id: source.session.id,
    workspaceId: source.session.workspaceId,
    status: source.session.status === 'initializing' ? 'idle' : source.session.status,
    createdAt: source.session.createdAt,
    updatedAt: source.session.updatedAt,
    latestSequence: source.latestSequence,
    earliestReplayableSequence: source.earliestReplayableSequence,
    projectionSequence: source.projectionSequence,
    transcript: { messages, ...(transcript?.updatedAt ? { updatedAt: transcript.updatedAt } : {}) },
    interaction,
  };
}

// Terminal runtime final/error events have two durable representations: the
// public journal and the replay transcript. Aborts intentionally settle only
// the journal so replay retains interruption semantics.
function hasTerminalTurnEvent(
  events: readonly { readonly type: string; readonly payload: Readonly<Record<string, unknown>> }[],
  turnId: string,
): boolean {
  return events.some(
    (event) => TERMINAL_AGENT_EVENT_TYPES.has(event.type as AgentEventType) && event.payload.turnId === turnId,
  );
}

function terminalTranscriptFact(event: ConversationEvent, turnId: string): LogEvent | null {
  if (event.type === 'final') {
    const finalText = boundedText(event.finalText, 16_384);
    const items = event.turnItems ? [...event.turnItems] : [];
    const existingText = items.findIndex((item) => item.type === 'assistant_text');
    if (existingText >= 0) {
      // Derived turn items may carry an empty assistant_text entry when the
      // stream produced no text parts; the terminal finalText is the
      // authoritative text for the persisted turn.
      const existing = items[existingText] as { type: 'assistant_text'; text?: string };
      if (!existing.text && finalText) items[existingText] = { ...existing, text: finalText };
    } else if (finalText) {
      items.push({ type: 'assistant_text', text: finalText });
    }
    return { type: 'assistant_turn', turnId, turn: { items } };
  }
  if (event.type === 'error') {
    return {
      type: 'assistant_turn',
      turnId,
      turn: { items: [{ type: 'assistant_text', text: boundedText(event.finalText ?? event.message, 16_384) }] },
    };
  }
  return null;
}

export function mapConversationEvent(
  event: ConversationEvent,
  turnId: string,
  sessionId: string,
  interactionBinding?: InteractionBinding,
  interactionSnapshot?: { approval: unknown; askUserAnswers: readonly unknown[]; currentAskUserQuestionIndex: number },
): import('./persistence/contracts.js').DurableEventCandidate | null {
  const base = { sessionId, payload: { turnId } };
  switch (event.type) {
    // The gateway-owned assistant_started admission marker is appended before
    // runtime commit in #submitMessage. ConversationEvent still has no provider
    // first-token signal, so this mapper never invents one from a delta.
    case 'text_delta':
      return { ...base, type: 'text_delta', payload: { turnId, delta: boundedText(event.delta) } };
    case 'reasoning_delta':
      return { ...base, type: 'reasoning_delta', payload: { turnId, delta: boundedText(event.delta) } };
    case 'tool_started':
      return {
        ...base,
        type: 'tool_started',
        payload: { turnId, callId: event.toolCallId, toolName: boundedText(event.toolName, 256) },
      };
    case 'command_message':
      return commandMessageCandidate(base, event.message, 'command_message');
    case 'approval_required': {
      if (!interactionBinding) return null;
      return {
        ...base,
        type: 'approval_required',
        payload: {
          turnId,
          interaction: interactionSnapshot
            ? interactionDtoFromSnapshot(
                interactionSnapshot,
                interactionBinding.publicInteractionId,
                interactionBinding.revision,
              )
            : interactionDtoFromApproval(
                event.approval as unknown as Record<string, unknown>,
                interactionBinding.publicInteractionId,
                interactionBinding.revision,
              ),
        },
      };
    }
    case 'usage_update': {
      const inputTokens = safeCounter(event.usage.prompt_tokens);
      const outputTokens = safeCounter(event.usage.completion_tokens);
      const totalTokens = safeCounter(event.usage.total_tokens) || inputTokens + outputTokens;
      return {
        ...base,
        type: 'usage_update',
        payload: {
          turnId,
          inputTokens,
          outputTokens,
          totalTokens,
          usage: { inputTokens, outputTokens, totalTokens },
        },
      };
    }
    case 'retry':
      return {
        ...base,
        type: 'retry',
        payload: {
          turnId,
          ...(event.agentId ? { agentId: boundedText(event.agentId, 256) } : {}),
          toolName: boundedText(event.toolName, 256),
          attempt: boundedInteger(event.attempt, 512),
          maxRetries: boundedInteger(event.maxRetries, 512),
          errorMessage: boundedText(event.errorMessage),
          ...(event.retryType ? { retryType: event.retryType } : {}),
          ...(event.errorKind ? { errorKind: event.errorKind } : {}),
          ...(event.delayMs !== undefined ? { delayMs: boundedInteger(event.delayMs, 86_400_000) } : {}),
          ...(event.retryAfterMs !== undefined ? { retryAfterMs: boundedInteger(event.retryAfterMs, 86_400_000) } : {}),
        },
      };
    case 'retry_exhausted':
      return {
        ...base,
        type: 'retry_exhausted',
        payload: {
          turnId,
          ...(event.provider ? { provider: boundedText(event.provider, 256) } : {}),
          errorKind: event.errorKind,
          attempts: boundedInteger(event.attempts, 512),
          maxAttempts: boundedInteger(event.maxAttempts, 512),
          message: boundedText(event.message),
          canRetry: event.canRetry,
        },
      };
    case 'subagent_started':
      return {
        ...base,
        type: 'subagent_started',
        payload: {
          turnId,
          agentId: boundedText(event.agentId, 256),
          ...(event.name ? { name: boundedText(event.name, 256) } : {}),
          role: boundedText(event.role, 256),
          task: boundedText(event.task, 16_384),
          ...(event.async !== undefined ? { async: event.async } : {}),
        },
      };
    case 'subagent_tool_started':
      return {
        ...base,
        type: 'subagent_tool_started',
        payload: {
          turnId,
          agentId: boundedText(event.agentId, 256),
          role: boundedText(event.role, 256),
          toolCallId: boundedText(event.toolCallId, 256),
          toolName: boundedText(event.toolName, 256),
          ...(event.commandMessages
            ? {
                commandMessages: event.commandMessages
                  .slice(0, 64)
                  .map((message) => commandMessagePayload(message))
                  .filter(Boolean),
              }
            : {}),
        },
      };
    case 'subagent_text_turn':
      return {
        ...base,
        type: 'subagent_text_turn',
        payload: {
          turnId,
          agentId: boundedText(event.agentId, 256),
          role: boundedText(event.role, 256),
          text: boundedText(event.text, 16_384),
        },
      };
    case 'subagent_command_message':
      return commandMessageCandidate(
        {
          ...base,
          type: 'subagent_command_message',
          payload: {
            turnId,
            agentId: boundedText(event.agentId, 256),
            role: boundedText(event.role, 256),
          },
        },
        event.message,
        'subagent_command_message',
      );
    case 'subagent_approval_required':
      if (!interactionBinding) return null;
      return {
        ...base,
        type: 'subagent_approval_required',
        payload: {
          turnId,
          agentId: boundedText(event.agentId, 256),
          role: boundedText(event.role, 256),
          interaction: interactionBinding.dto,
        },
      };
    case 'subagent_completed': {
      const result = event.result;
      return {
        ...base,
        type: 'subagent_completed',
        payload: {
          turnId,
          agentId: boundedText(result.agentId, 256),
          ...(result.name ? { name: boundedText(result.name, 256) } : {}),
          role: boundedText(result.role, 256),
          status: result.status,
          finalText: boundedText(result.finalText, 16_384),
          ...(result.finalTextTruncated !== undefined ? { finalTextTruncated: result.finalTextTruncated } : {}),
          toolsUsed: result.toolsUsed.slice(0, 64).map((tool) => ({
            toolName: boundedText(tool.toolName, 256),
            count: boundedInteger(tool.count, 1_000_000),
          })),
          ...(result.usage ? { usage: normalizedUsagePayload(result.usage) } : {}),
          ...(result.error ? { error: boundedText(result.error) } : {}),
          ...(result.terminalCause ? { terminalCause: boundedText(String(result.terminalCause), 128) } : {}),
          ...(event.async !== undefined ? { async: event.async } : {}),
        },
      };
    }
    case 'subagent_interrupted':
      return {
        ...base,
        type: 'subagent_interrupted',
        payload: {
          turnId,
          agentId: boundedText(event.agentId, 256),
          role: boundedText(event.role, 256),
          finalText: boundedText(event.finalText, 16_384),
        },
      };
    case 'subagent_question':
      return {
        ...base,
        type: 'subagent_question',
        payload: {
          turnId,
          agentId: boundedText(event.runId, 256),
          runId: boundedText(event.runId, 256),
          messageId: boundedText(event.messageId, 256),
          role: boundedText(event.role, 256),
          ...(event.name ? { name: boundedText(event.name, 256) } : {}),
          question: boundedText(event.question),
          async: true,
          ...(interactionBinding ? { interaction: interactionBinding.dto } : {}),
        },
      };
    case 'context_compaction_started':
      return {
        ...base,
        type: 'context_compaction_started',
        payload: {
          turnId,
          provider: boundedText(event.provider, 256),
          sessionId: boundedText(event.sessionId, 256),
          ...(event.inputTokensBefore !== undefined ? { inputTokensBefore: safeCounter(event.inputTokensBefore) } : {}),
          ...(event.strategy ? { strategy: event.strategy } : {}),
        },
      };
    case 'context_compaction_completed':
      return {
        ...base,
        type: 'context_compaction_completed',
        payload: {
          turnId,
          provider: boundedText(event.provider, 256),
          sessionId: boundedText(event.sessionId, 256),
          ...(event.inputTokensBefore !== undefined ? { inputTokensBefore: safeCounter(event.inputTokensBefore) } : {}),
          ...(event.inputTokensAfter !== undefined ? { inputTokensAfter: safeCounter(event.inputTokensAfter) } : {}),
          durationMs: boundedInteger(event.durationMs, 86_400_000),
          ...(event.strategy ? { strategy: event.strategy } : {}),
        },
      };
    case 'context_compaction_failed':
      return {
        ...base,
        type: 'context_compaction_failed',
        payload: {
          turnId,
          provider: boundedText(event.provider, 256),
          sessionId: boundedText(event.sessionId, 256),
          errorCategory: event.errorCategory,
          durationMs: boundedInteger(event.durationMs, 86_400_000),
          ...(event.strategy ? { strategy: event.strategy } : {}),
        },
      };
    case 'final':
      return {
        ...base,
        type: 'turn_completed',
        payload: { turnId, outcome: 'completed', text: boundedText(event.finalText, 16_384) },
      };
    case 'error':
      return {
        ...base,
        type: 'turn_failed',
        payload: {
          turnId,
          outcome: 'failed',
          reason: errorReason(event.kind),
          ...(event.finalText ? { finalText: boundedText(event.finalText, 16_384) } : {}),
        },
      };
    default:
      return null;
  }
}

export { createGatewayAssertion, interactionDtoFromSnapshot, isPublicEventEnvelope };
export type { SessionBinding };
