import { randomUUID } from 'node:crypto';
import { ExecutionContext } from '../services/execution-context.js';
const SAFE_ENV_KEYS = new Set(['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TMPDIR', 'TERM2_SESSION_ID']);
const SECRET_ENV_PATTERN = /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|COOKIE|SSH)/i;
export class WorkerBoundaryError extends Error {
    code;
    constructor(code) {
        super('gateway worker boundary rejected');
        this.name = 'WorkerBoundaryError';
        this.code = code;
    }
}
export function assertProviderBrokerReady(capability, probe) {
    if (!capability || !capability.capabilityId || !capability.providerId || !capability.modelId) {
        throw new WorkerBoundaryError('provider_unavailable');
    }
    if (typeof capability.request !== 'function' || typeof capability.stream !== 'function') {
        throw new WorkerBoundaryError('invalid_broker');
    }
    if (!probe?.available || !probe.secretFree)
        throw new WorkerBoundaryError('provider_unavailable');
    if ('execute' in capability || 'spawn' in capability)
        throw new WorkerBoundaryError('invalid_broker');
    return capability;
}
function createSessionScopedProviderBroker(base, sessionId, options = {}) {
    const capabilityId = randomUUID();
    let revoked = false;
    let requestCount = 0;
    const maxRequestsPerTurn = options.maxRequestsPerTurn;
    const consumeRequest = () => {
        if (maxRequestsPerTurn !== undefined && ++requestCount > maxRequestsPerTurn) {
            throw new WorkerBoundaryError('provider_unavailable');
        }
    };
    const validateRequest = (input) => {
        if (!input || typeof input !== 'object')
            throw new WorkerBoundaryError('invalid_broker');
        const candidate = input;
        if (!Array.isArray(candidate.messages) ||
            candidate.messages.length > 10_000 ||
            'headers' in candidate ||
            'url' in candidate ||
            'apiKey' in candidate) {
            throw new WorkerBoundaryError('invalid_broker');
        }
    };
    const scoped = {
        capabilityId,
        providerId: base.providerId,
        modelId: base.modelId,
        request: async (input) => {
            if (!sessionId || revoked)
                throw new WorkerBoundaryError('invalid_broker');
            validateRequest(input);
            consumeRequest();
            return base.request(input);
        },
        stream: async function* (input) {
            if (!sessionId || revoked)
                throw new WorkerBoundaryError('invalid_broker');
            validateRequest(input);
            consumeRequest();
            yield* base.stream(input);
        },
        resetRequestBudget: () => {
            requestCount = 0;
        },
        revoke: () => {
            revoked = true;
        },
    };
    return scoped;
}
function createSecretFreeWorkerSettings(capability, canonicalRoot, snapshot) {
    if (!capability && !snapshot)
        throw new WorkerBoundaryError('provider_unavailable');
    return Object.freeze({
        providerId: snapshot?.providerId ?? capability.providerId,
        modelId: snapshot?.modelId ?? capability.modelId,
        ...(capability ? { brokerCapabilityId: capability.capabilityId } : {}),
        executionRoot: canonicalRoot,
        envPolicyVersion: 1,
        ...(snapshot
            ? {
                reasoningEffort: snapshot.reasoningEffort,
                mode: snapshot.mode,
                toolPolicy: snapshot.effectiveToolPolicy,
                ...(snapshot.defaultsRevision === undefined ? {} : { defaultsRevision: snapshot.defaultsRevision }),
            }
            : {}),
    });
}
export function createSanitizedWorkerEnv(input) {
    if (!input.sessionId ||
        !input.tmpDir ||
        !input.tmpDir.startsWith('/') ||
        ['/tmp', '/var/tmp'].includes(input.tmpDir.replace(/\/+$/, '')))
        throw new WorkerBoundaryError('unsafe_environment');
    const env = {
        PATH: input.path ?? '/usr/bin:/bin',
        LANG: input.locale ?? 'C.UTF-8',
        LC_ALL: input.locale ?? 'C.UTF-8',
        TMPDIR: input.tmpDir,
        TERM2_SESSION_ID: input.sessionId,
    };
    for (const [key, value] of Object.entries(env)) {
        if (!SAFE_ENV_KEYS.has(key) || SECRET_ENV_PATTERN.test(key) || value.includes('\u0000')) {
            throw new WorkerBoundaryError('unsafe_environment');
        }
    }
    return Object.freeze(env);
}
export function assertExplicitSanitizedEnv(env) {
    for (const [key, value] of Object.entries(env)) {
        if (!SAFE_ENV_KEYS.has(key) || SECRET_ENV_PATTERN.test(key) || value.includes('\u0000')) {
            throw new WorkerBoundaryError('unsafe_environment');
        }
    }
    if (!env.TMPDIR ||
        ['/tmp', '/var/tmp'].includes(env.TMPDIR.replace(/\/+$/, '')) ||
        env.SSH_AUTH_SOCK ||
        Object.keys(env).some((key) => SECRET_ENV_PATTERN.test(key))) {
        throw new WorkerBoundaryError('unsafe_environment');
    }
}
/** Composes the session-owned capabilities without changing process cwd or env. */
export function composeGatewaySession(options) {
    if (options.sandboxAvailable !== true)
        throw new WorkerBoundaryError('sandbox_unavailable');
    const providerBroker = options.providerBroker
        ? createSessionScopedProviderBroker(assertProviderBrokerReady(options.providerBroker, options.providerProbe), options.binding.sessionId, { maxRequestsPerTurn: options.maxProviderRequestsPerTurn })
        : undefined;
    const settings = createSecretFreeWorkerSettings(providerBroker, options.binding.canonicalRoot, options.settingsSnapshot);
    const env = options.env ?? createSanitizedWorkerEnv({ sessionId: options.binding.sessionId, tmpDir: options.tmpDir });
    assertExplicitSanitizedEnv(env);
    const executionContext = ExecutionContext.pin(options.binding.canonicalRoot);
    const runtime = options.createRuntime?.({ executionContext, settings, env, providerBroker });
    let disposed = false;
    return {
        sessionId: options.binding.sessionId,
        binding: options.binding,
        executionContext,
        settings,
        providerBroker,
        ...(options.settingsSnapshot ? { sessionSettingsSnapshot: options.settingsSnapshot } : {}),
        env,
        spawnOptions: { cwd: options.binding.canonicalRoot, env, gatewayMode: true },
        runtime,
        dispose() {
            if (disposed)
                return;
            disposed = true;
            runtime?.dispose();
            providerBroker?.revoke?.();
        },
    };
}
//# sourceMappingURL=worker-boundary.js.map