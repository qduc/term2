import { expect, it, vi } from 'vitest';
import {
  MENTOR_MODE_ENTER_NOTICE,
  ORCHESTRATOR_MODE_ENTER_NOTICE,
  PLAN_MODE_ENTER_NOTICE,
  PLAN_MODE_EXIT_NOTICE,
} from './mode-notices.js';
import { ConversationConfigurationService } from './runtime-setting-router.js';

const makeService = (overrides: Record<string, unknown> = {}) => {
  const settingsService = {
    setDynamicTransaction: vi.fn(),
    setPersistentDynamic: vi.fn(),
    reset: vi.fn(),
    set: vi.fn(),
    isRuntimeModifiable: vi.fn(() => true),
    getDynamic: vi.fn(() => false),
    get: vi.fn((key: string) =>
      key === 'app.activeProfileId' ? 'builtin:standard' : key === 'agent.model' ? 'current-model' : false,
    ),
    ...overrides,
  } as any;
  const conversationService = { switchProvider: vi.fn(), queueModeNotice: vi.fn() };
  const setModel = vi.fn();
  const service = new ConversationConfigurationService({
    settingsService,
    conversationService,
    setModel,
    setReasoningEffort: vi.fn(),
    setTemperature: vi.fn(),
  });
  return { service, settingsService, conversationService, setModel };
};

it('applies all runtime changes through one settings transaction before runtime effects', () => {
  const { service, settingsService, conversationService } = makeService();

  service.apply([
    { key: 'agent.provider', value: 'openrouter', persistence: 'runtime' },
    { key: 'agent.model', value: 'x', persistence: 'runtime' },
  ]);

  expect(settingsService.setDynamicTransaction).toHaveBeenCalledWith([
    { key: 'agent.provider', value: 'openrouter' },
    { key: 'agent.model', value: 'x' },
  ]);
  expect(conversationService.switchProvider).toHaveBeenCalledWith('openrouter');
});

it('does not invoke runtime effects when the settings transaction rejects', () => {
  const { service, settingsService, conversationService } = makeService({
    setDynamicTransaction: vi.fn(() => {
      throw new Error('invalid');
    }),
  });

  expect(() => service.apply([{ key: 'agent.provider', value: 'bad', persistence: 'runtime' }])).toThrow('invalid');
  expect(conversationService.switchProvider).not.toHaveBeenCalled();
});

it('canonicalizes a legacy Plan write before routing its transition', () => {
  const { service, conversationService } = makeService();

  service.apply([{ key: 'app.planMode', value: true, persistence: 'runtime' }]);

  expect(conversationService.queueModeNotice).toHaveBeenCalledWith(PLAN_MODE_ENTER_NOTICE);
});

it('does not route legacy plan-mode exits', () => {
  const { service, conversationService } = makeService();

  service.apply([{ key: 'app.planMode', value: false, persistence: 'runtime' }]);

  expect(conversationService.queueModeNotice).not.toHaveBeenCalled();
});

it.each([
  ['app.mentorMode', true],
  ['app.orchestratorMode', true],
])('canonicalizes legacy %s writes before routing', (key, value) => {
  const { service, conversationService, setModel } = makeService();

  service.apply([{ key, value, persistence: 'runtime' }]);

  expect(conversationService.queueModeNotice).toHaveBeenCalled();
  expect(setModel).toHaveBeenCalledWith('current-model');
});

it('composes the Plan exit when a legacy mode write replaces Plan', () => {
  const { service, conversationService } = makeService({
    get: vi.fn((key: string) => (key === 'app.activeProfileId' ? 'builtin:plan' : 'current-model')),
  });

  service.apply([{ key: 'app.liteMode', value: true, persistence: 'runtime' }]);

  expect(conversationService.queueModeNotice).toHaveBeenCalledWith(PLAN_MODE_EXIT_NOTICE);
});

it('activating the plan profile queues its notice without rebuilding the agent', () => {
  const { service, settingsService, conversationService, setModel } = makeService({
    get: vi.fn((key: string) => (key === 'app.activeProfileId' ? 'builtin:standard' : 'gpt-4o')),
  });

  service.apply([{ key: 'app.activeProfileId', value: 'builtin:plan', persistence: 'runtime' }]);

  expect(conversationService.queueModeNotice).toHaveBeenCalledWith(PLAN_MODE_ENTER_NOTICE);
  expect(setModel).not.toHaveBeenCalled();
  expect(settingsService.set).toHaveBeenCalledWith('app.activeProfileId', 'builtin:plan');
});

it('activating the mentor profile rebuilds the agent and queues its notice', () => {
  const { service, settingsService, conversationService, setModel } = makeService({
    get: vi.fn((key: string) => (key === 'app.activeProfileId' ? 'builtin:standard' : 'gpt-4o')),
  });

  service.apply([{ key: 'app.activeProfileId', value: 'builtin:mentor', persistence: 'runtime' }]);

  expect(setModel).toHaveBeenCalledWith('gpt-4o');
  expect(conversationService.queueModeNotice).toHaveBeenCalledWith(MENTOR_MODE_ENTER_NOTICE);
  expect(settingsService.set).toHaveBeenCalledWith('app.activeProfileId', 'builtin:mentor');
});

it('plans the profile transition before the settings transaction commits it', () => {
  let activeProfileId = 'builtin:standard';
  const { service, settingsService, conversationService, setModel } = makeService({
    get: vi.fn((key: string) => (key === 'app.activeProfileId' ? activeProfileId : 'gpt-4o')),
    setDynamicTransaction: vi.fn(() => {
      activeProfileId = 'builtin:mentor';
    }),
  });

  service.apply([{ key: 'app.activeProfileId', value: 'builtin:mentor', persistence: 'runtime' }]);

  expect(setModel).toHaveBeenCalledWith('gpt-4o');
  expect(conversationService.queueModeNotice).toHaveBeenCalledWith(MENTOR_MODE_ENTER_NOTICE);
  expect(settingsService.set).not.toHaveBeenCalled();
});

it('maps legacy mode changes in transaction order', () => {
  let activeProfileId = 'builtin:standard';
  const { service, settingsService } = makeService({
    get: vi.fn((key: string) => (key === 'app.activeProfileId' ? activeProfileId : 'gpt-4o')),
    setDynamicTransaction: vi.fn((changes: readonly { key: string; value: unknown }[]) => {
      for (const change of changes) {
        if (change.key === 'app.activeProfileId') activeProfileId = String(change.value);
      }
    }),
  });

  service.apply([
    { key: 'app.planMode', value: true, persistence: 'runtime' },
    { key: 'app.liteMode', value: false, persistence: 'runtime' },
  ]);

  expect(activeProfileId).toBe('builtin:plan');
  expect(settingsService.setDynamicTransaction).toHaveBeenCalledWith([
    { key: 'app.activeProfileId', value: 'builtin:plan' },
    { key: 'app.activeProfileId', value: 'builtin:plan' },
  ]);
});
