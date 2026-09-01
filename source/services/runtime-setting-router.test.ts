import { expect, it, vi } from 'vitest';
import {
  MENTOR_MODE_ENTER_NOTICE,
  MENTOR_MODE_EXIT_NOTICE,
  ORCHESTRATOR_MODE_ENTER_NOTICE,
  ORCHESTRATOR_MODE_EXIT_NOTICE,
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
    getDynamic: vi.fn(() => 'default'),
    get: vi.fn(() => 'current-model'),
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

it('queues the plan-mode enter notice when app.planMode becomes true', () => {
  const { service, conversationService } = makeService();

  service.apply([{ key: 'app.planMode', value: true, persistence: 'runtime' }]);

  expect(conversationService.queueModeNotice).toHaveBeenCalledWith(PLAN_MODE_ENTER_NOTICE);
});

it('queues the plan-mode exit notice when app.planMode becomes false', () => {
  const { service, conversationService } = makeService();

  service.apply([{ key: 'app.planMode', value: false, persistence: 'runtime' }]);

  expect(conversationService.queueModeNotice).toHaveBeenCalledWith(PLAN_MODE_EXIT_NOTICE);
});

it.each([
  ['app.mentorMode', true, MENTOR_MODE_ENTER_NOTICE],
  ['app.mentorMode', false, MENTOR_MODE_EXIT_NOTICE],
  ['app.orchestratorMode', true, ORCHESTRATOR_MODE_ENTER_NOTICE],
  ['app.orchestratorMode', false, ORCHESTRATOR_MODE_EXIT_NOTICE],
])('queues the %s notice when its runtime value becomes %s', (key, value, notice) => {
  const { service, conversationService } = makeService();

  service.apply([{ key, value, persistence: 'runtime' }]);

  expect(conversationService.queueModeNotice).toHaveBeenCalledWith(notice);
});

it('queues the plan-mode exit notice when another exclusive mode implicitly turns Plan Mode off', () => {
  let planMode = true;
  const { service, conversationService } = makeService({
    get: vi.fn((key: string) => (key === 'app.planMode' ? planMode : 'current-model')),
    setDynamicTransaction: vi.fn(() => {
      planMode = false;
    }),
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
