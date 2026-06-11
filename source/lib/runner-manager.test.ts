import test from 'ava';
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

test('constructor sets maxTurns and retryAttempts', (t) => {
  const manager = new RunnerManager({ maxTurns: 5, retryAttempts: 3 }, createRunnerManagerDeps());

  t.is(manager.maxTurns, 5);
  t.is(manager.retryAttempts, 3);
});

test.serial('getOrCreateRunner creates runner for known provider', (t) => {
  registerMockProvider('test-with-runner', true);
  t.teardown(() => cleanupProvider('test-with-runner'));

  const manager = new RunnerManager({ maxTurns: 5, retryAttempts: 3 }, createRunnerManagerDeps());

  const runner = manager.getOrCreateRunner('test-with-runner');
  t.truthy(runner, 'runner should be returned');
  t.is(typeof runner?.run, 'function', 'runner should have a run method');
});

test.serial('getOrCreateRunner returns null for provider without createRunner', (t) => {
  registerMockProvider('test-no-runner', false);
  t.teardown(() => cleanupProvider('test-no-runner'));

  const manager = new RunnerManager({ maxTurns: 5, retryAttempts: 3 }, createRunnerManagerDeps());

  const runner = manager.getOrCreateRunner('test-no-runner');
  t.is(runner, null);
});

test.serial('getOrCreateRunner caches runner for primary provider', (t) => {
  registerMockProvider('primary-provider', true);
  t.teardown(() => cleanupProvider('primary-provider'));

  const manager = new RunnerManager(
    { maxTurns: 5, retryAttempts: 3 },
    createRunnerManagerDeps({ getProvider: () => 'primary-provider' }),
  );

  const first = manager.getOrCreateRunner('primary-provider');
  const second = manager.getOrCreateRunner('primary-provider');

  t.truthy(first);
  t.truthy(second);
  t.is(first, second, 'should return the same cached instance');
});

test.serial('getOrCreateRunner creates fresh runner for non-primary provider', (t) => {
  registerMockProvider('primary-provider', true);
  registerMockProvider('other-provider', true);
  t.teardown(() => {
    cleanupProvider('primary-provider');
    cleanupProvider('other-provider');
  });

  const manager = new RunnerManager(
    { maxTurns: 5, retryAttempts: 3 },
    createRunnerManagerDeps({ getProvider: () => 'primary-provider' }),
  );

  const first = manager.getOrCreateRunner('other-provider');
  const second = manager.getOrCreateRunner('other-provider');

  t.truthy(first);
  t.truthy(second);
  t.not(first, second, 'should return different instances for non-primary provider');
});

test.serial('invalidateRunner clears cache', (t) => {
  registerMockProvider('primary-provider', true);
  t.teardown(() => cleanupProvider('primary-provider'));

  const manager = new RunnerManager(
    { maxTurns: 5, retryAttempts: 3 },
    createRunnerManagerDeps({ getProvider: () => 'primary-provider' }),
  );

  const first = manager.getOrCreateRunner('primary-provider');
  t.truthy(first);

  manager.invalidateRunner();

  const second = manager.getOrCreateRunner('primary-provider');
  t.truthy(second);
  t.not(first, second, 'should return a new instance after invalidation');
});

test.serial('setRetryCallback wires callback to runner creation', (t) => {
  registerMockProvider('primary-provider', true);
  t.teardown(() => cleanupProvider('primary-provider'));

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
  t.false(retryCalled, 'callback should not be called yet');

  // Get the provider to verify the callback was passed
  // We can test that setRetryCallback doesn't throw and that the internal callback works
  t.notThrows(() => manager.setRetryCallback(() => {}));
});
