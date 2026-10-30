import path from 'node:path';
import { realpathSync, statSync } from 'node:fs';
import { ConversationService } from '../services/conversation/conversation-service.js';
import { createOwnedSessionClientFactory } from '../services/session/session-client-factory.js';
import { SessionContextService } from '../services/session/session-context-service.js';
import { LoggingService } from '../services/logging/logging-service.js';
import { SettingsService } from '../services/settings/settings-service.js';
import { SkillsService } from '../services/skills/skills-service.js';
import { composeGatewaySession } from './worker-boundary.js';
import { createSessionSettingsSnapshot } from './launcher-seam.js';
import { ServerSession } from './server-session.js';
import { AgentClient } from '../lib/agent-client.js';
import { installPlanModeInterceptor } from '../services/plan-mode-interceptor.js';
const DEFAULT_RUNTIME_RESOURCE_POLICY = Object.freeze({
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
export const PRODUCTION_AUTHORITY_SETTING_KEYS = [
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
    'webSearch.firecrawl.apiKey',
    'webSearch.firecrawl.baseUrl',
    'webSearch.searxng.baseUrl',
];
export class RuntimeFactoryError extends Error {
    code;
    constructor(code) {
        super('gateway runtime factory rejected');
        this.name = 'RuntimeFactoryError';
        this.code = code;
    }
}
/**
 * Build the production gateway runtime around the launcher's settings owner.
 * The owner is deliberately used as a credential source only; each session
 * gets its own settings overlay and its own AgentClient graph.
 */
export function createProductionRuntimeFactory(input) {
    const providerSettingKeys = new Set(PRODUCTION_AUTHORITY_SETTING_KEYS);
    const providerDynamicKeys = new Set([
        // Runtime provider definitions are installed by the launcher and may
        // contain provider-local credentials; they stay process-local here.
        'providers',
    ]);
    const createSettings = (_defaults, sessionDir, snapshot) => {
        const local = createDefaultSettings(_defaults, sessionDir, input.policy?.maxParallelToolCalls ?? 1, snapshot);
        const authority = input.settingsAuthority;
        const sandboxEnabled = authority.get('sandbox.enabled');
        if (typeof sandboxEnabled === 'boolean')
            local.set('sandbox.enabled', sandboxEnabled, { persist: false });
        // SettingsService intentionally has no public clone operation. This
        // narrow overlay preserves launcher-owned credentials and defaults while
        // keeping mutable model/session choices isolated per gateway session.
        return {
            get: ((key) => providerSettingKeys.has(key)
                ? authority.get(key)
                : local.get(key)),
            getDynamic: (key) => (providerDynamicKeys.has(key) ? authority.getDynamic(key) : local.getDynamic(key)),
            set: ((key, value, options) => local.set(key, value, options)),
            setDynamic: (key, value, options) => local.setDynamic(key, value, options),
            setPersistent: ((key, value) => local.setPersistent(key, value)),
            setPersistentDynamic: (key, value) => local.setPersistentDynamic(key, value),
            onChange: (listener) => {
                const localUnsubscribe = local.onChange?.(listener);
                const authorityUnsubscribe = authority.onChange?.(listener);
                return () => {
                    localUnsubscribe?.();
                    authorityUnsubscribe?.();
                };
            },
        };
    };
    return new RuntimeFactory({
        allowWrite: input.allowWrite,
        tmpDir: input.tmpDir,
        policy: input.policy,
        providerProbe: input.providerProbe,
        sandboxAvailable: input.sandboxAvailable,
        settingsAuthority: input.settingsAuthority,
        modelCatalogLogger: input.modelCatalogLogger,
        createLogger: input.createLogger,
        createSessionContext: input.createSessionContext,
        onAgentClientDeps: input.onAgentClientDeps,
        createSettingsSnapshot: (binding) => createSessionSettingsSnapshot({
            settings: input.settingsAuthority,
            effectiveToolPolicy: {
                allowWrite: input.allowWrite === true && binding.access === 'read_write',
            },
        }),
        createSettings,
        createAgentClient: ({ settings, logger, sessionContextService, executionContext, skillsService, toolOwnership, postExecutePauseCapability, sessionAccess, requestCapture, toolLifecycle, continuationProjectionMode, sessionSettingsSnapshot, readOnly, }) => {
            const client = new AgentClient({
                selection: { model: sessionSettingsSnapshot.modelId, provider: sessionSettingsSnapshot.providerId },
                reasoningEffort: sessionSettingsSnapshot.reasoningEffort,
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
                    allowUnsandboxed: sessionSettingsSnapshot.effectiveToolPolicy.allowUnsandboxed === true,
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
function resolveRuntimeResourcePolicy(input) {
    const merged = { ...DEFAULT_RUNTIME_RESOURCE_POLICY, ...(input ?? {}) };
    const finitePositive = (value) => Number.isSafeInteger(value) && value > 0;
    if (!finitePositive(merged.maxLiveSessions) ||
        !finitePositive(merged.maxQueuedSubmissions) ||
        merged.maxQueuedSubmissions > 32 ||
        !finitePositive(merged.preparedLeaseTtlMs) ||
        !finitePositive(merged.maxActiveTurnMs) ||
        !finitePositive(merged.maxProviderRequestsPerTurn) ||
        !finitePositive(merged.maxParallelToolCalls) ||
        !finitePositive(merged.maxToolOutputBytes) ||
        merged.maxShellJobs !== 0 ||
        !finitePositive(merged.shutdownGraceMs) ||
        !finitePositive(merged.maxLiveSessionsPerOwner)) {
        throw new RuntimeFactoryError('resource_limit');
    }
    return Object.freeze(merged);
}
function assertBinding(binding) {
    if (!binding ||
        !binding.sessionId ||
        !binding.ownerUserId ||
        !binding.workspaceId ||
        !Number.isSafeInteger(binding.grantVersion) ||
        !path.isAbsolute(binding.canonicalRoot) ||
        (binding.access !== 'read' && binding.access !== 'read_write'))
        throw new RuntimeFactoryError('invalid_binding');
    try {
        if (realpathSync(binding.canonicalRoot) !== binding.canonicalRoot ||
            !statSync(binding.canonicalRoot).isDirectory()) {
            throw new Error();
        }
    }
    catch {
        throw new RuntimeFactoryError('invalid_binding');
    }
}
function createDefaultSettings(defaults, tmpDir, maxParallelToolCalls = 1, snapshot) {
    const settings = new SettingsService({
        settingsDir: path.join(tmpDir, 'settings'),
        disableFilePersistence: true,
        disableLogging: true,
        env: {},
        cli: {},
    });
    settings.set('agent.modelSelection', { model: defaults.modelId, provider: defaults.providerId }, { persist: false });
    if (snapshot) {
        settings.set('agent.reasoningEffort', snapshot.reasoningEffort, { persist: false });
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
    #options;
    #policy;
    #sessions = new Map();
    #owners = new Map();
    #creating = new Set();
    #closed = false;
    constructor(options) {
        if (!options.createAgentClient)
            throw new RuntimeFactoryError('client_factory_missing');
        this.#options = options;
        this.#policy = resolveRuntimeResourcePolicy(options.policy);
    }
    get policy() {
        return this.#policy;
    }
    get liveSessionCount() {
        return this.#sessions.size;
    }
    get settingsAuthority() {
        return this.#options.settingsAuthority;
    }
    get allowWriteEnabled() {
        return this.#options.allowWrite === true;
    }
    get modelCatalogLogger() {
        return this.#options.modelCatalogLogger;
    }
    get usesRealProviderStack() {
        return !this.#options.providerBroker;
    }
    async create(binding, options) {
        assertBinding(binding);
        if (this.#closed)
            throw new RuntimeFactoryError('closed');
        if (this.#sessions.has(binding.sessionId) || this.#creating.has(binding.sessionId)) {
            throw new RuntimeFactoryError('invalid_binding');
        }
        if (this.#sessions.size >= this.#policy.maxLiveSessions)
            throw new RuntimeFactoryError('resource_limit');
        const ownerCount = this.#owners.get(binding.ownerUserId) ?? 0;
        if (ownerCount >= this.#policy.maxLiveSessionsPerOwner)
            throw new RuntimeFactoryError('resource_limit');
        this.#creating.add(binding.sessionId);
        let composition;
        const sessionSettingsSnapshot = options?.settingsSnapshot ??
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
        }
        catch (error) {
            this.#creating.delete(binding.sessionId);
            throw error;
        }
        const context = this.#options.createSessionContext?.() ?? new SessionContextService();
        const logger = this.#options.createLogger?.(binding.sessionId, context) ??
            new LoggingService({
                disableLogging: true,
                suppressConsoleOutput: true,
                sessionContextService: context,
            });
        const settings = this.#options.createSettings?.(composition.settings, path.join(this.#options.tmpDir, binding.sessionId), sessionSettingsSnapshot) ??
            createDefaultSettings(composition.settings, path.join(this.#options.tmpDir, binding.sessionId), this.#policy.maxParallelToolCalls, sessionSettingsSnapshot);
        composition.sessionSettingsService = settings;
        const skills = this.#options.createSkills?.(logger, binding.canonicalRoot) ?? new SkillsService(logger, binding.canonicalRoot);
        const sessionClientFactory = createOwnedSessionClientFactory(settings, (sessionId, toolOwnership, postExecutePauseCapability, access, continuationProjectionMode, providerContinuity, requestCapture, toolLifecycle) => {
            this.#options.onAgentClientDeps?.({
                readOnly: access.isReadOnly,
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
                sessionSettingsSnapshot: sessionSettingsSnapshot,
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
                readOnly: access.isReadOnly,
                allowBackgroundShell: this.#policy.maxShellJobs > 0,
                maxToolOutputBytes: this.#policy.maxToolOutputBytes,
            });
        }, undefined, {
            allowBackgroundShell: this.#policy.maxShellJobs > 0,
            allowEdit: binding.access === 'read_write' && sessionSettingsSnapshot?.effectiveToolPolicy.allowWrite === true,
        });
        let service;
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
                handle: service.sessionHandle,
                composition,
                policy: this.#policy,
                eventSink: options?.eventSink,
                onDispose: () => {
                    this.#sessions.delete(binding.sessionId);
                    const next = (this.#owners.get(binding.ownerUserId) ?? 1) - 1;
                    if (next <= 0)
                        this.#owners.delete(binding.ownerUserId);
                    else
                        this.#owners.set(binding.ownerUserId, next);
                    this.#options.onResourceReleased?.(binding.sessionId);
                },
            });
            this.#sessions.set(binding.sessionId, session);
            this.#owners.set(binding.ownerUserId, ownerCount + 1);
            this.#creating.delete(binding.sessionId);
            return session;
        }
        catch (error) {
            this.#creating.delete(binding.sessionId);
            service?.dispose();
            await Promise.resolve(composition.dispose());
            throw error;
        }
    }
    async shutdown(graceMs = this.#policy.shutdownGraceMs) {
        this.#closed = true;
        await Promise.race([
            Promise.all([...this.#sessions.values()].map((session) => session.dispose('shutdown'))).then(() => undefined),
            new Promise((resolve) => setTimeout(resolve, Math.max(1, graceMs))),
        ]);
    }
}
//# sourceMappingURL=runtime-factory.js.map