import { randomUUID } from 'node:crypto';
import { ExecutionContext } from '../services/execution-context.js';
import type {
  GatewaySessionComposition,
  ProviderBrokerCapability,
  SecretFreeWorkerSettings,
  SessionBinding,
} from './contracts.js';

const SAFE_ENV_KEYS = new Set(['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TMPDIR', 'TERM2_SESSION_ID']);
const SECRET_ENV_PATTERN = /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|COOKIE|SSH)/i;

export class WorkerBoundaryError extends Error {
  readonly code: 'provider_unavailable' | 'invalid_broker' | 'unsafe_environment' | 'sandbox_unavailable';
  constructor(code: WorkerBoundaryError['code']) {
    super('gateway worker boundary rejected');
    this.name = 'WorkerBoundaryError';
    this.code = code;
  }
}

export type WorkerBoundaryProbe = {
  available: boolean;
  secretFree: boolean;
};

export function assertProviderBrokerReady(
  capability: ProviderBrokerCapability | undefined,
  probe: WorkerBoundaryProbe | undefined,
): ProviderBrokerCapability {
  if (!capability || !capability.capabilityId || !capability.providerId || !capability.modelId) {
    throw new WorkerBoundaryError('provider_unavailable');
  }
  if (typeof capability.request !== 'function' || typeof capability.stream !== 'function') {
    throw new WorkerBoundaryError('invalid_broker');
  }
  if (!probe?.available || !probe.secretFree) throw new WorkerBoundaryError('provider_unavailable');
  if ('execute' in capability || 'spawn' in capability) throw new WorkerBoundaryError('invalid_broker');
  return capability;
}

export function createSessionScopedProviderBroker(
  base: ProviderBrokerCapability,
  sessionId: string,
  options: { maxRequestsPerTurn?: number } = {},
): ProviderBrokerCapability {
  const capabilityId = randomUUID();
  let revoked = false;
  let requestCount = 0;
  const maxRequestsPerTurn = options.maxRequestsPerTurn;
  const consumeRequest = (): void => {
    if (maxRequestsPerTurn !== undefined && ++requestCount > maxRequestsPerTurn) {
      throw new WorkerBoundaryError('provider_unavailable');
    }
  };
  const validateRequest = (input: unknown): void => {
    if (!input || typeof input !== 'object') throw new WorkerBoundaryError('invalid_broker');
    const candidate = input as Record<string, unknown>;
    if (
      !Array.isArray(candidate.messages) ||
      candidate.messages.length > 10_000 ||
      'headers' in candidate ||
      'url' in candidate ||
      'apiKey' in candidate
    ) {
      throw new WorkerBoundaryError('invalid_broker');
    }
  };
  const scoped: ProviderBrokerCapability & { revoke(): void; resetRequestBudget(): void } = {
    capabilityId,
    providerId: base.providerId,
    modelId: base.modelId,
    request: async (input) => {
      if (!sessionId || revoked) throw new WorkerBoundaryError('invalid_broker');
      validateRequest(input);
      consumeRequest();
      return base.request(input);
    },
    stream: async function* (input) {
      if (!sessionId || revoked) throw new WorkerBoundaryError('invalid_broker');
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

export function createSecretFreeWorkerSettings(
  capability: ProviderBrokerCapability,
  canonicalRoot: string,
): SecretFreeWorkerSettings {
  return Object.freeze({
    providerId: capability.providerId,
    modelId: capability.modelId,
    brokerCapabilityId: capability.capabilityId,
    executionRoot: canonicalRoot,
    envPolicyVersion: 1,
  });
}

export function createSanitizedWorkerEnv(input: {
  sessionId: string;
  tmpDir: string;
  path?: string;
  locale?: string;
}): Readonly<Record<string, string>> {
  if (
    !input.sessionId ||
    !input.tmpDir ||
    !input.tmpDir.startsWith('/') ||
    ['/tmp', '/var/tmp'].includes(input.tmpDir.replace(/\/+$/, ''))
  )
    throw new WorkerBoundaryError('unsafe_environment');
  const env: Record<string, string> = {
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

export function assertExplicitSanitizedEnv(env: Readonly<Record<string, string>>): void {
  for (const [key, value] of Object.entries(env)) {
    if (!SAFE_ENV_KEYS.has(key) || SECRET_ENV_PATTERN.test(key) || value.includes('\u0000')) {
      throw new WorkerBoundaryError('unsafe_environment');
    }
  }
  if (
    !env.TMPDIR ||
    ['/tmp', '/var/tmp'].includes(env.TMPDIR.replace(/\/+$/, '')) ||
    env.SSH_AUTH_SOCK ||
    Object.keys(env).some((key) => SECRET_ENV_PATTERN.test(key))
  ) {
    throw new WorkerBoundaryError('unsafe_environment');
  }
}

export type GatewaySessionCompositionOptions = {
  binding: SessionBinding;
  providerBroker: ProviderBrokerCapability;
  providerProbe: WorkerBoundaryProbe;
  tmpDir: string;
  env?: Readonly<Record<string, string>>;
  sandboxAvailable?: boolean;
  maxProviderRequestsPerTurn?: number;
  createRuntime?: (input: {
    executionContext: ExecutionContext;
    settings: SecretFreeWorkerSettings;
    env: Readonly<Record<string, string>>;
    providerBroker: ProviderBrokerCapability;
  }) => GatewaySessionComposition['runtime'];
};

/** Composes the session-owned capabilities without changing process cwd or env. */
export function composeGatewaySession(options: GatewaySessionCompositionOptions): GatewaySessionComposition {
  if (options.sandboxAvailable !== true) throw new WorkerBoundaryError('sandbox_unavailable');
  const baseProviderBroker = assertProviderBrokerReady(options.providerBroker, options.providerProbe);
  const providerBroker = createSessionScopedProviderBroker(baseProviderBroker, options.binding.sessionId, {
    maxRequestsPerTurn: options.maxProviderRequestsPerTurn,
  });
  const settings = createSecretFreeWorkerSettings(providerBroker, options.binding.canonicalRoot);
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
    env,
    spawnOptions: { cwd: options.binding.canonicalRoot, env, gatewayMode: true },
    runtime,
    dispose() {
      if (disposed) return;
      disposed = true;
      runtime?.dispose();
      (providerBroker as ProviderBrokerCapability & { revoke?: () => void }).revoke?.();
    },
  };
}
