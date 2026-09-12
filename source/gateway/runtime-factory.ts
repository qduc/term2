import path from 'node:path';
import { realpathSync, statSync } from 'node:fs';
import { ConversationService } from '../services/conversation/conversation-service.js';
import type { ConversationAgentClient } from '../services/conversation-agent-client.js';
import { createOwnedSessionClientFactory } from '../services/session/session-client-factory.js';
import type { ILoggingService, ISettingsService, ISessionContextService } from '../services/service-interfaces.js';
import { SessionContextService } from '../services/session/session-context-service.js';
import { LoggingService } from '../services/logging/logging-service.js';
import { SettingsService } from '../services/settings/settings-service.js';
import { SkillsService } from '../services/skills/skills-service.js';
import { composeGatewaySession, type WorkerBoundaryProbe } from './worker-boundary.js';
import type {
  GatewaySessionComposition,
  ProviderBrokerCapability,
  SecretFreeWorkerSettings,
  SessionSettingsSnapshot,
  SessionBinding,
} from './contracts.js';
import { createSessionSettingsSnapshot } from './launcher-seam.js';
import { ServerSession, type ServerSessionOptions } from './server-session.js';
import type { ToolOwnershipRegistry } from '../services/approval/tool-ownership-registry.js';
import type { PostExecutePauseCapability } from '../services/session/post-execute-pause-capability.js';
import type { SessionAccessState } from '../services/session/session-access-state.js';
import type { ProviderContinuity } from '../services/provider-continuity.js';
import type { OpenAICandidateObserver } from '../services/openai-candidate-observer.js';
import type { ToolExecutionLifecyclePort } from '../tools/types.js';
import { AgentClient } from '../lib/agent-client.js';
import { installPlanModeInterceptor } from '../services/plan-mode-interceptor.js';
import type { ModelSettingsReasoningEffort } from '../services/models/reasoning-effort.js';

export type RuntimeResourcePolicy = Readonly<{
  maxLiveSessions: number;
  maxQueuedSubmissions: number;
  preparedLeaseTtlMs: number;
  maxActiveTurnMs: number;
  maxProviderRequestsPerTurn: number;
  maxParallelToolCalls: number;
  maxToolOutputBytes: number;
  maxShellJobs: 0;
  shutdownGraceMs: number;
  maxLiveSessionsPerOwner: number;
}>;

export const DEFAULT_RUNTIME_RESOURCE_POLICY: RuntimeResourcePolicy = Object.freeze({
  maxLiveSessions: 16,
  maxQueuedSubmissions: 32,
  preparedLeaseTtlMs: 10_000,
  maxActiveTurnMs: 300_000,
  maxProviderRequestsPerTurn: 64,
  maxParallelToolCalls: 1,
  maxToolOutputBytes: 1_048_576,
  maxShellJobs: 0,
  shutdownGraceMs: 5_000,
  maxLiveSessionsPerOwner: 4,
});

/**
 * Settings the production factory reads from the launcher's authority on
 * behalf of every session. Every entry needs a reason, and every entry must
 * stay a provider/transport/web-search input: the structural test in
 * `runtime-factory.test.ts` fails if an entry grants shell, sandbox,
 * profile, or tool-enablement authority to a session.
 */
export const PRODUCTION_AUTHORITY_SETTING_KEYS: readonly string[] = [
  // Provider API keys are read in-process by the provider adapter and never
  // enter a DTO, log record, or child-process environment.
  'agent.openai.apiKey',
  // OpenRouter's adapter resolves this key when constructing its model.
  'agent.openrouter.apiKey',
  // OpenRouter adapter's API endpoint override for gateways and mirrors.
  'agent.openrouter.baseUrl',
  // OpenRouter attribution header (HTTP-Referer) the adapter sends.
  'agent.openrouter.referrer',
  // OpenRouter attribution header (X-Title) the adapter sends.
  'agent.openrouter.title',
  // Selects which Codex transport (websocket vs HTTP) the adapter opens.
  'agent.transport',
  // Bounds the Codex websocket's first-frame wait inside the adapter.
  'agent.codex.websocketFirstFrameTimeoutMs',
  // Bounds the Codex websocket's inter-frame idle wait inside the adapter.
  'agent.codex.websocketInterFrameTimeoutMs',
  // The web-search tool reads this key when it executes in-process.
  'webSearch.tavily.apiKey',
  // The web-search tool reads this key when it executes in-process.
  'webSearch.exa.apiKey',
];

export class RuntimeFactoryError extends Error {
  readonly code:
    | 'invalid_binding'
    | 'resource_limit'
    | 'provider_unavailable'
    | 'sandbox_unavailable'
    | 'closed'
    | 'client_factory_missing';
  constructor(code: RuntimeFactoryError['code']) {
    super('gateway runtime factory rejected');
    this.name = 'RuntimeFactoryError';
    this.code = code;
  }
}

export type GatewayAgentClientFactory = (input: {
  sessionId: string;
  binding: SessionBinding;
  settings: ISettingsService;
  defaults: SecretFreeWorkerSettings;
  logger: ILoggingService;
  sessionContextService: ISessionContextService;
  executionContext: GatewaySessionComposition['executionContext'];
  skillsService: SkillsService;
  providerBroker?: ProviderBrokerCapability;
  toolOwnership: ToolOwnershipRegistry;
  postExecutePauseCapability: PostExecutePauseCapability;
  sessionAccess: SessionAccessState;
  readOnly: boolean;
  providerContinuity: ProviderContinuity;
  requestCapture: OpenAICandidateObserver;
  toolLifecycle?: ToolExecutionLifecyclePort;
  continuationProjectionMode: import('../lib/continuation-projection-mode.js').ContinuationProjectionMode;
  env: Readonly<Record<string, string>>;
  spawnOptions: GatewaySessionComposition['spawnOptions'];
  policy: RuntimeResourcePolicy;
  gatewayMode: true;
  allowBackgroundShell: boolean;
  maxToolOutputBytes: number;
  sessionSettingsSnapshot: SessionSettingsSnapshot;
}) => ConversationAgentClient;

export type RuntimeFactoryOptions = {
  policy?: Partial<RuntimeResourcePolicy>;
  /** Legacy fixture capability. Omit this for the real provider stack. */
  providerBroker?: ProviderBrokerCapability;
  providerProbe?: WorkerBoundaryProbe;
  tmpDir: string;
  sandboxAvailable: true;
  allowWrite?: boolean;
  createAgentClient: GatewayAgentClientFactory;
  createLogger?: (sessionId: string, context: ISessionContextService) => ILoggingService;
  createSettings?: (
    _defaults: SecretFreeWorkerSettings,
    tmpDir: string,
    snapshot: SessionSettingsSnapshot,
  ) => ISettingsService;
  /** The launcher's authority is read to create a snapshot, never shared with a session. */
  settingsAuthority?: ISettingsService;
  createSettingsSnapshot?: (binding: SessionBinding) => SessionSettingsSnapshot;
  modelCatalogLogger?: ILoggingService;
  /** Test seam for asserting the composed session access posture. */
  onAgentClientDeps?: (input: { readOnly: boolean; sessionAccess: SessionAccessState }) => void;
  createSessionContext?: () => ISessionContextService;
  createSkills?: (logger: ILoggingService, canonicalRoot: string) => SkillsService;
  onResourceReleased?: (sessionId: string) => void;
  /** Test seam; production uses the adapter's conservative bound. */
  activeCancelTimeoutMs?: number;
};

/**
 * Build the production gateway runtime around the launcher's settings owner.
 * The owner is deliberately used as a credential source only; each session
 * gets its own settings overlay and its own AgentClient graph.
 */
export function createProductionRuntimeFactory(input: {
  settingsAuthority: ISettingsService;
  tmpDir: string;
  sandboxAvailable: true;
  allowWrite?: boolean;
  policy?: Partial<RuntimeResourcePolicy>;
  providerProbe?: WorkerBoundaryProbe;
  createLogger?: RuntimeFactoryOptions['createLogger'];
  createSessionContext?: RuntimeFactoryOptions['createSessionContext'];
  modelCatalogLogger?: ILoggingService;
  onAgentClientDeps?: RuntimeFactoryOptions['onAgentClientDeps'];
}): RuntimeFactory {
  const providerSettingKeys = new Set(PRODUCTION_AUTHORITY_SETTING_KEYS);
  const providerDynamicKeys = new Set([
    // Runtime provider definitions are installed by the launcher and may
    // contain provider-local credentials; they stay process-local here.
    'providers',
  ]);
  const createSettings = (
    _defaults: SecretFreeWorkerSettings,
    sessionDir: string,
    snapshot: SessionSettingsSnapshot,
  ) => {
    const local = createDefaultSettings(_defaults, sessionDir, input.policy?.maxParallelToolCalls ?? 1, snapshot);
    const authority = input.settingsAuthority;
    // SettingsService intentionally has no public clone operation. This
    // narrow overlay preserves launcher-owned credentials and defaults while
    // keeping mutable model/session choices isolated per gateway session.
    return {
      get: ((key: string) =>
        providerSettingKeys.has(key)
          ? authority.get(key as never)
          : local.get(key as never)) as ISettingsService['get'],
      getDynamic: (key: string) => (providerDynamicKeys.has(key) ? authority.getDynamic(key) : local.getDynamic(key)),
      set: ((key: string, value: unknown, options?: { persist?: boolean }) =>
        local.set(key as never, value as never, options)) as ISettingsService['set'],
      setDynamic: (key: string, value: unknown, options?: { persist?: boolean }) =>
        local.setDynamic(key, value, options),
      setPersistent: ((key: string, value: unknown) =>
        local.setPersistent(key as never, value as never)) as ISettingsService['setPersistent'],
      setPersistentDynamic: (key: string, value: unknown) => local.setPersistentDynamic(key, value),
      onChange: (listener: (key?: string) => void) => {
        const localUnsubscribe = local.onChange?.(listener);
        const authorityUnsubscribe = authority.onChange?.(listener);
        return () => {
          localUnsubscribe?.();
          authorityUnsubscribe?.();
        };
      },
    } satisfies ISettingsService;
  };

  return new RuntimeFactory({
    tmpDir: input.tmpDir,
    policy: input.policy,
    providerProbe: input.providerProbe,
    sandboxAvailable: input.sandboxAvailable,
    settingsAuthority: input.settingsAuthority,
    modelCatalogLogger: input.modelCatalogLogger,
    createLogger: input.createLogger,
    createSessionContext: input.createSessionContext,
    onAgentClientDeps: input.onAgentClientDeps,
    createSettingsSnapshot: (binding) =>
      createSessionSettingsSnapshot({
        settings: input.settingsAuthority,
        effectiveToolPolicy: {
          allowWrite: input.allowWrite === true && binding.access === 'read_write',
        },
      }),
    createSettings,
    createAgentClient: ({
      settings,
      logger,
      sessionContextService,
      executionContext,
      skillsService,
      toolOwnership,
      postExecutePauseCapability,
      sessionAccess,
      requestCapture,
      toolLifecycle,
      continuationProjectionMode,
      sessionSettingsSnapshot,
      readOnly,
    }) => {
      const client = new AgentClient({
        model: sessionSettingsSnapshot.modelId,
        reasoningEffort: sessionSettingsSnapshot.reasoningEffort as ModelSettingsReasoningEffort,
        maxTurns: settings.get('agent.maxTurns'),
        retryAttempts: settings.get('agent.retryAttempts'),
        deps: {
          logger,
          settings,
          executionContext,
          sessionContextService,
          skillsService,
          requestCapture,
          readOnly,
        },
        toolOwnership,
        postExecutePauseCapability,
        sessionAccess,
        continuationProjectionMode,
        toolLifecycle,
        // Background shells are deferred from the gateway wire; maxShellJobs
        // is fixed at zero by the gateway resource policy.
        allowBackgroundShell: false,
        allowAskUser: true,
      });
      installPlanModeInterceptor(client, { settingsService: settings });
      return client;
    },
  });
}

export function resolveRuntimeResourcePolicy(input?: Partial<RuntimeResourcePolicy>): RuntimeResourcePolicy {
  const merged = { ...DEFAULT_RUNTIME_RESOURCE_POLICY, ...(input ?? {}) };
  const finitePositive = (value: number): boolean => Number.isSafeInteger(value) && value > 0;
  if (
    !finitePositive(merged.maxLiveSessions) ||
    !finitePositive(merged.maxQueuedSubmissions) ||
    merged.maxQueuedSubmissions > 32 ||
    !finitePositive(merged.preparedLeaseTtlMs) ||
    !finitePositive(merged.maxActiveTurnMs) ||
    !finitePositive(merged.maxProviderRequestsPerTurn) ||
    !finitePositive(merged.maxParallelToolCalls) ||
    !finitePositive(merged.maxToolOutputBytes) ||
    merged.maxShellJobs !== 0 ||
    !finitePositive(merged.shutdownGraceMs) ||
    !finitePositive(merged.maxLiveSessionsPerOwner)
  ) {
    throw new RuntimeFactoryError('resource_limit');
  }
  return Object.freeze(merged);
}

function assertBinding(binding: SessionBinding): void {
  if (
    !binding ||
    !binding.sessionId ||
    !binding.ownerUserId ||
    !binding.workspaceId ||
    !Number.isSafeInteger(binding.grantVersion) ||
    !path.isAbsolute(binding.canonicalRoot) ||
    (binding.access !== 'read' && binding.access !== 'read_write')
  )
    throw new RuntimeFactoryError('invalid_binding');
  try {
    if (
      realpathSync(binding.canonicalRoot) !== binding.canonicalRoot ||
      !statSync(binding.canonicalRoot).isDirectory()
    ) {
      throw new Error();
    }
  } catch {
    throw new RuntimeFactoryError('invalid_binding');
  }
}

function createDefaultSettings(
  defaults: SecretFreeWorkerSettings,
  tmpDir: string,
  maxParallelToolCalls = 1,
  snapshot?: SessionSettingsSnapshot,
): ISettingsService {
  const settings = new SettingsService({
    settingsDir: path.join(tmpDir, 'settings'),
    disableFilePersistence: true,
    disableLogging: true,
    env: {},
    cli: {},
  });
  settings.set('agent.provider', defaults.providerId, { persist: false });
  settings.set('agent.model', defaults.modelId, { persist: false });
  if (snapshot) {
    settings.set('agent.reasoningEffort', snapshot.reasoningEffort as never, { persist: false });
  }
  settings.set('agent.maxParallelToolCalls', maxParallelToolCalls, { persist: false });
  return settings;
}

/**
 * Owns the complete term2-facing per-session graph. The agent-client callback
 * is the provider-adapter seam: it receives only the session-scoped broker and
 * never receives host credentials or an ambient environment.
 */
export class RuntimeFactory {
  readonly #options: RuntimeFactoryOptions;
  readonly #policy: RuntimeResourcePolicy;
  readonly #sessions = new Map<string, ServerSession>();
  readonly #owners = new Map<string, number>();
  readonly #creating = new Set<string>();
  #closed = false;

  constructor(options: RuntimeFactoryOptions) {
    if (!options.createAgentClient) throw new RuntimeFactoryError('client_factory_missing');
    this.#options = options;
    this.#policy = resolveRuntimeResourcePolicy(options.policy);
  }

  get policy(): RuntimeResourcePolicy {
    return this.#policy;
  }
  get liveSessionCount(): number {
    return this.#sessions.size;
  }
  get settingsAuthority(): ISettingsService | undefined {
    return this.#options.settingsAuthority;
  }
  get modelCatalogLogger(): ILoggingService | undefined {
    return this.#options.modelCatalogLogger;
  }
  get usesRealProviderStack(): boolean {
    return !this.#options.providerBroker;
  }

  async create(
    binding: SessionBinding,
    options?: {
      eventSink?: ServerSessionOptions['eventSink'];
      /** Overrides the factory's snapshot chain; the gateway supplies the persisted per-session snapshot when reviving. */
      settingsSnapshot?: SessionSettingsSnapshot;
    },
  ): Promise<ServerSession> {
    assertBinding(binding);
    if (this.#closed) throw new RuntimeFactoryError('closed');
    if (this.#sessions.has(binding.sessionId) || this.#creating.has(binding.sessionId)) {
      throw new RuntimeFactoryError('invalid_binding');
    }
    if (this.#sessions.size >= this.#policy.maxLiveSessions) throw new RuntimeFactoryError('resource_limit');
    const ownerCount = this.#owners.get(binding.ownerUserId) ?? 0;
    if (ownerCount >= this.#policy.maxLiveSessionsPerOwner) throw new RuntimeFactoryError('resource_limit');
    this.#creating.add(binding.sessionId);

    let composition: ReturnType<typeof composeGatewaySession>;
    const sessionSettingsSnapshot =
      options?.settingsSnapshot ??
      this.#options.createSettingsSnapshot?.(binding) ??
      (this.#options.settingsAuthority
        ? createSessionSettingsSnapshot({
            settings: this.#options.settingsAuthority,
            // A launcher must opt in to write access through its explicit
            // snapshot callback; binding access alone is not authority.
            effectiveToolPolicy: { allowWrite: false },
          })
        : undefined);
    if (!this.#options.providerBroker && !sessionSettingsSnapshot) {
      this.#creating.delete(binding.sessionId);
      throw new RuntimeFactoryError('provider_unavailable');
    }
    try {
      composition = composeGatewaySession({
        binding,
        providerBroker: this.#options.providerBroker,
        providerProbe: this.#options.providerProbe,
        settingsSnapshot: sessionSettingsSnapshot,
        tmpDir: path.join(this.#options.tmpDir, binding.sessionId),
        sandboxAvailable: this.#options.sandboxAvailable,
        maxProviderRequestsPerTurn: this.#policy.maxProviderRequestsPerTurn,
      });
    } catch (error) {
      this.#creating.delete(binding.sessionId);
      throw error;
    }
    const context = this.#options.createSessionContext?.() ?? new SessionContextService();
    const logger =
      this.#options.createLogger?.(binding.sessionId, context) ??
      new LoggingService({
        disableLogging: true,
        suppressConsoleOutput: true,
        sessionContextService: context,
      });
    const settings =
      this.#options.createSettings?.(
        composition.settings,
        path.join(this.#options.tmpDir, binding.sessionId),
        sessionSettingsSnapshot!,
      ) ??
      createDefaultSettings(
        composition.settings,
        path.join(this.#options.tmpDir, binding.sessionId),
        this.#policy.maxParallelToolCalls,
        sessionSettingsSnapshot,
      );
    composition.sessionSettingsService = settings;
    const skills =
      this.#options.createSkills?.(logger, binding.canonicalRoot) ?? new SkillsService(logger, binding.canonicalRoot);
    const sessionClientFactory = createOwnedSessionClientFactory(
      settings,
      (
        sessionId,
        toolOwnership,
        postExecutePauseCapability,
        access,
        continuationProjectionMode,
        providerContinuity,
        requestCapture,
        toolLifecycle,
      ) => {
        this.#options.onAgentClientDeps?.({
          readOnly: binding.access === 'read' || sessionSettingsSnapshot?.effectiveToolPolicy.allowWrite !== true,
          sessionAccess: access,
        });
        return this.#options.createAgentClient({
          sessionId,
          binding,
          settings,
          defaults: composition.settings,
          logger,
          sessionContextService: context,
          executionContext: composition.executionContext,
          skillsService: skills,
          providerBroker: composition.providerBroker,
          sessionSettingsSnapshot: sessionSettingsSnapshot!,
          toolOwnership,
          postExecutePauseCapability,
          sessionAccess: access,
          providerContinuity,
          requestCapture,
          toolLifecycle,
          continuationProjectionMode,
          env: composition.env,
          spawnOptions: composition.spawnOptions,
          policy: this.#policy,
          gatewayMode: true,
          allowBackgroundShell: this.#policy.maxShellJobs > 0,
          maxToolOutputBytes: this.#policy.maxToolOutputBytes,
          readOnly: binding.access === 'read' || sessionSettingsSnapshot?.effectiveToolPolicy.allowWrite !== true,
        });
      },
      undefined,
      {
        allowBackgroundShell: this.#policy.maxShellJobs > 0,
        allowEdit: binding.access === 'read_write' && sessionSettingsSnapshot?.effectiveToolPolicy.allowWrite === true,
      },
    );
    let service: ConversationService | undefined;
    try {
      service = new ConversationService({
        sessionClientFactory,
        sessionId: binding.sessionId,
        deps: { logger, settingsService: settings, sessionContextService: context, skillsService: skills },
        queueCapacity: this.#policy.maxQueuedSubmissions,
        preparedLeaseTtlMs: this.#policy.preparedLeaseTtlMs,
        activeCancelTimeoutMs: this.#options.activeCancelTimeoutMs,
        discardOnFailure: true,
      });
      const session = new ServerSession({
        binding,
        service,
        composition,
        policy: this.#policy,
        eventSink: options?.eventSink,
        onDispose: () => {
          this.#sessions.delete(binding.sessionId);
          const next = (this.#owners.get(binding.ownerUserId) ?? 1) - 1;
          if (next <= 0) this.#owners.delete(binding.ownerUserId);
          else this.#owners.set(binding.ownerUserId, next);
          this.#options.onResourceReleased?.(binding.sessionId);
        },
      });
      this.#sessions.set(binding.sessionId, session);
      this.#owners.set(binding.ownerUserId, ownerCount + 1);
      this.#creating.delete(binding.sessionId);
      return session;
    } catch (error) {
      this.#creating.delete(binding.sessionId);
      service?.dispose();
      await Promise.resolve(composition.dispose());
      throw error;
    }
  }

  async shutdown(graceMs = this.#policy.shutdownGraceMs): Promise<void> {
    this.#closed = true;
    await Promise.race([
      Promise.all([...this.#sessions.values()].map((session) => session.dispose('shutdown'))).then(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, Math.max(1, graceMs))),
    ]);
  }
}
