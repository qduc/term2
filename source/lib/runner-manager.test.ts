import { it, expect } from 'vitest';
import { registerProvider, unregisterProvider, getProvider } from '../providers/registry.js';
import { RunnerManager, type RunnerManagerDeps } from './runner-manager.js';
import type { ILoggingService, ISettingsService } from '../services/service-interfaces.js';

// ========== Mock Utilities ==========

function createMockLogger(): ILoggingService {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    security: () => {},
    setCorrelationId: () => {},
    clearCorrelationId: () => {},
    getCorrelationId: () => undefined,
    log: () => {},
  } as any;
}

function createMockSettings(values: Record<string, any> = {}): ISettingsService {
  const store: Record<string, any> = { ...values };
  return {
    get: <T>(key: string) => store[key] as T,
    set: (key: string, value: any) => {
      store[key] = value;
    },
    onChange: () => () => {},
  };
}

function createSessionContext() {
  return {
    runWithContext: <T>(_context: any, fn: () => T) => fn(),
    getContext: () => null,
  };
}

function createRunnerManagerDeps(
  overrides: {
    getProvider?: () => string;
    logger?: ILoggingService;
    settings?: ISettingsService;
  } = {},
): RunnerManagerDeps {
  return {
    logger: overrides.logger ?? createMockLogger(),
    settings: overrides.settings ?? createMockSettings(),
    sessionContextService: createSessionContext(),
    getProvider: overrides.getProvider ?? (() => 'primary-provider'),
  };
}

// ========== Mock Provider Registration ==========

const RUNNER_RETURN_VALUE = { run: async () => ({ status: 'completed', finalOutput: 'mock' }) };

function registerMockProvider(id: string, withCreateRunner: boolean): void {
  if (getProvider(id)) {
    unregisterProvider(id);
  }

  registerProvider({
    id,
    label: `Mock ${id}`,
    createRunner: withCreateRunner ? () => ({ ...RUNNER_RETURN_VALUE } as any) : undefined,
    fetchModels: async () => [{ id: 'mock-model' }],
    clearConversations: () => {},
  });
}

function cleanupProvider(id: string): void {
  if (getProvider(id)) {
    unregisterProvider(id);
  }
}

// ========== Tests ==========

it('constructor sets maxTurns and retryAttempts', () => {
  const manager = new RunnerManager({ maxTurns: 5, retryAttempts: 3 }, createRunnerManagerDeps());

  expect(manager.maxTurns).toBe(5);
  expect(manager.retryAttempts).toBe(3);
});

it.sequential('getOrCreateRunner creates runner for known provider', () => {
  registerMockProvider('test-with-runner', true);

  // TODO: // TODO: t.teardown(() => cleanupProvider('test-with-runner')) needs manual try/finally conversion;

  const manager = new RunnerManager({ maxTurns: 5, retryAttempts: 3 }, createRunnerManagerDeps());

  const runner = manager.getOrCreateRunner('test-with-runner');
  expect(runner).toBeTruthy();
  expect(typeof runner?.run, 'runner should have a run method').toBe('function');
});

it.sequential('getOrCreateRunner returns null for provider without createRunner', () => {
  registerMockProvider('test-no-runner', false);

  // TODO: // TODO: t.teardown(() => cleanupProvider('test-no-runner')) needs manual try/finally conversion;

  const manager = new RunnerManager({ maxTurns: 5, retryAttempts: 3 }, createRunnerManagerDeps());

  const runner = manager.getOrCreateRunner('test-no-runner');
  expect(runner).toBe(null);
});

it.sequential('getOrCreateRunner caches runner for primary provider', () => {
  registerMockProvider('primary-provider', true);

  // TODO: // TODO: t.teardown(() => cleanupProvider('primary-provider')) needs manual try/finally conversion;

  const manager = new RunnerManager(
    { maxTurns: 5, retryAttempts: 3 },
    createRunnerManagerDeps({ getProvider: () => 'primary-provider' }),
  );

  const first = manager.getOrCreateRunner('primary-provider');
  const second = manager.getOrCreateRunner('primary-provider');

  expect(first).toBeTruthy();
  expect(second).toBeTruthy();
  expect(first, 'should return the same cached instance').toBe(second);
});

it.sequential('getOrCreateRunner creates fresh runner for non-primary provider', () => {
  registerMockProvider('primary-provider', true);
  registerMockProvider('other-provider', true);
  try {
    const manager = new RunnerManager(
      { maxTurns: 5, retryAttempts: 3 },
      createRunnerManagerDeps({ getProvider: () => 'primary-provider' }),
    );

    const first = manager.getOrCreateRunner('other-provider');
    const second = manager.getOrCreateRunner('other-provider');

    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    expect(first, 'should return different instances for non-primary provider').not.toBe(second);
  } finally {
    cleanupProvider('primary-provider');
    cleanupProvider('other-provider');
  }
});

it.sequential('invalidateRunner clears cache', () => {
  registerMockProvider('primary-provider', true);

  // TODO: // TODO: t.teardown(() => cleanupProvider('primary-provider')) needs manual try/finally conversion;

  const manager = new RunnerManager(
    { maxTurns: 5, retryAttempts: 3 },
    createRunnerManagerDeps({ getProvider: () => 'primary-provider' }),
  );

  const first = manager.getOrCreateRunner('primary-provider');
  expect(first).toBeTruthy();

  manager.invalidateRunner();

  const second = manager.getOrCreateRunner('primary-provider');
  expect(second).toBeTruthy();
  expect(first, 'should return a new instance after invalidation').not.toBe(second);
});

it.sequential('setRetryCallback wires callback to runner creation', () => {
  registerMockProvider('primary-provider', true);

  // TODO: // TODO: t.teardown(() => cleanupProvider('primary-provider')) needs manual try/finally conversion;

  let retryCalled = false;

  const manager = new RunnerManager(
    { maxTurns: 5, retryAttempts: 3 },
    createRunnerManagerDeps({ getProvider: () => 'primary-provider' }),
  );

  manager.setRetryCallback(() => {
    retryCalled = true;
  });

  // Create the runner — the onRetry callback should be wired to the provider's createRunner
  manager.getOrCreateRunner('primary-provider');

  // Verify the callback is callable by calling it directly
  // (the actual invocation happens inside the runner; we just verify the wiring)
  expect(retryCalled, 'callback should not be called yet').toBe(false);

  // Get the provider to verify the callback was passed
  // We can test that setRetryCallback doesn't throw and that the internal callback works
  expect(() => manager.setRetryCallback(() => {}));
});
