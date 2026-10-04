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
      key === 'app.activeProfileId' ? 'builtin:standard' : key === 'agent.modelSelection' ? { model: 'current-model', provider: 'openai' } : false,
    ),
    ...overrides,
  } as any;
  const conversationService = { queueModeNotice: vi.fn() };
  const setModelSelection = vi.fn();
  const service = new ConversationConfigurationService({
    settingsService,
    conversationService,
    setModelSelection,
    setReasoningEffort: vi.fn(),
    setTemperature: vi.fn(),
  });
  return { service, settingsService, conversationService, setModelSelection };
};

it('applies all runtime changes through one settings transaction before runtime effects', () => {
  const { service, settingsService, setModelSelection } = makeService();

  service.apply([
    { key: 'agent.modelSelection', value: { model: 'x', provider: 'openrouter' }, persistence: 'runtime' },
  ]);

  expect(settingsService.setDynamicTransaction).toHaveBeenCalledWith([
    { key: 'agent.modelSelection', value: { model: 'x', provider: 'openrouter' } },
  ]);
  expect(setModelSelection).toHaveBeenCalledWith({ model: 'x', provider: 'openrouter' });
});

it('does not invoke runtime effects when the settings transaction rejects', () => {
  const { service, setModelSelection } = makeService({
    setDynamicTransaction: vi.fn(() => {
      throw new Error('invalid');
    }),
  });

  expect(() => service.apply([{ key: 'agent.modelSelection', value: { model: 'bad', provider: 'openai' }, persistence: 'runtime' }])).toThrow('invalid');
  expect(setModelSelection).not.toHaveBeenCalled();
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
  const { service, conversationService, setModelSelection } = makeService();

  service.apply([{ key, value, persistence: 'runtime' }]);

  expect(conversationService.queueModeNotice).toHaveBeenCalled();
  expect(setModelSelection).toHaveBeenCalledWith({ model: 'current-model', provider: 'openai' });
});

it('composes the Plan exit when a legacy mode write replaces Plan', () => {
  const { service, conversationService } = makeService({
    get: vi.fn((key: string) => (key === 'app.activeProfileId' ? 'builtin:plan' : { model: 'current-model', provider: 'openai' })),
  });

  service.apply([{ key: 'app.liteMode', value: true, persistence: 'runtime' }]);

  expect(conversationService.queueModeNotice).toHaveBeenCalledWith(PLAN_MODE_EXIT_NOTICE);
});

it('activating the plan profile queues its notice without rebuilding the agent', () => {
  const { service, settingsService, conversationService, setModelSelection } = makeService({
    get: vi.fn((key: string) => (key === 'app.activeProfileId' ? 'builtin:standard' : { model: 'gpt-4o', provider: 'openai' })),
  });

  service.apply([{ key: 'app.activeProfileId', value: 'builtin:plan', persistence: 'runtime' }]);

  expect(conversationService.queueModeNotice).toHaveBeenCalledWith(PLAN_MODE_ENTER_NOTICE);
  expect(setModelSelection).not.toHaveBeenCalled();
  expect(settingsService.set).toHaveBeenCalledWith('app.activeProfileId', 'builtin:plan');
});

it('activating the mentor profile rebuilds the agent and queues its notice', () => {
  const { service, settingsService, conversationService, setModelSelection } = makeService({
    get: vi.fn((key: string) => (key === 'app.activeProfileId' ? 'builtin:standard' : { model: 'gpt-4o', provider: 'openai' })),
  });

  service.apply([{ key: 'app.activeProfileId', value: 'builtin:mentor', persistence: 'runtime' }]);

  expect(setModelSelection).toHaveBeenCalledWith({ model: 'gpt-4o', provider: 'openai' });
  expect(conversationService.queueModeNotice).toHaveBeenCalledWith(MENTOR_MODE_ENTER_NOTICE);
  expect(settingsService.set).toHaveBeenCalledWith('app.activeProfileId', 'builtin:mentor');
});

it('plans the profile transition before the settings transaction commits it', () => {
  let activeProfileId = 'builtin:standard';
  const { service, settingsService, conversationService, setModelSelection } = makeService({
    get: vi.fn((key: string) => (key === 'app.activeProfileId' ? activeProfileId : { model: 'gpt-4o', provider: 'openai' })),
    setDynamicTransaction: vi.fn(() => {
      activeProfileId = 'builtin:mentor';
    }),
  });

  service.apply([{ key: 'app.activeProfileId', value: 'builtin:mentor', persistence: 'runtime' }]);

  expect(setModelSelection).toHaveBeenCalledWith({ model: 'gpt-4o', provider: 'openai' });
  expect(conversationService.queueModeNotice).toHaveBeenCalledWith(MENTOR_MODE_ENTER_NOTICE);
  expect(settingsService.set).not.toHaveBeenCalled();
});

it('rebuilds the agent when a tool capability toggle changes at runtime', () => {
  const { service, setModelSelection } = makeService();

  service.apply([{ key: 'tools.shell.enabled', value: false, persistence: 'runtime' }]);

  expect(setModelSelection).toHaveBeenCalledWith({ model: 'current-model', provider: 'openai' });
});

it('does not rebuild the agent for restart-persisted tool capability toggles', () => {
  const { service, setModelSelection, settingsService } = makeService();

  service.apply([{ key: 'tools.shell.enabled', value: false, persistence: 'restart' }]);

  expect(settingsService.setPersistentDynamic).toHaveBeenCalledWith('tools.shell.enabled', false);
  expect(setModelSelection).not.toHaveBeenCalled();
});

it('warns when a disabled tool toggle conflicts with the active built-in profile', () => {
  const { service, conversationService } = makeService({
    get: vi.fn((key: string) =>
      key === 'app.activeProfileId' ? 'builtin:lite' : key === 'agent.modelSelection' ? { model: { model: 'current-model', provider: 'openai' }, provider: 'openai' } : false,
    ),
    getDynamic: vi.fn((key: string) => (key === 'tools.shell.enabled' ? true : false)),
  });

  service.apply([{ key: 'tools.shell.enabled', value: false, persistence: 'runtime' }]);

  expect(conversationService.queueModeNotice).toHaveBeenCalledTimes(1);
  const notice = conversationService.queueModeNotice.mock.calls[0][0] as string;
  expect(notice).toContain('tools.shell.enabled');
  expect(notice).toContain('Lite');
});

it('composes every conflicting toggle from one batch into a single notice', () => {
  const { service, conversationService } = makeService({
    get: vi.fn((key: string) =>
      key === 'app.activeProfileId' ? 'builtin:lite' : key === 'agent.modelSelection' ? { model: { model: 'current-model', provider: 'openai' }, provider: 'openai' } : false,
    ),
    getDynamic: vi.fn((key: string) => key === 'tools.shell.enabled' || key === 'tools.web.enabled'),
  });

  service.apply([
    { key: 'tools.shell.enabled', value: false, persistence: 'runtime' },
    { key: 'tools.web.enabled', value: false, persistence: 'runtime' },
  ]);

  expect(conversationService.queueModeNotice).toHaveBeenCalledTimes(1);
  const notice = conversationService.queueModeNotice.mock.calls[0][0] as string;
  expect(notice).toContain('tools.shell.enabled');
  expect(notice).toContain('tools.web.enabled');
});

it('does not warn when a toggle is enabled or was already disabled', () => {
  const { service, conversationService } = makeService({
    get: vi.fn((key: string) =>
      key === 'app.activeProfileId' ? 'builtin:lite' : key === 'agent.modelSelection' ? { model: { model: 'current-model', provider: 'openai' }, provider: 'openai' } : false,
    ),
    // tools.shell.enabled reads false before the change: disabling it again is
    // not news, and enabling it never conflicts.
    getDynamic: vi.fn(() => false),
  });

  service.apply([
    { key: 'tools.shell.enabled', value: false, persistence: 'runtime' },
    { key: 'tools.web.enabled', value: true, persistence: 'runtime' },
  ]);

  expect(conversationService.queueModeNotice).not.toHaveBeenCalled();
});

it('warns on a capability toggle applied alongside a workflow-profile switch (both notices queue)', () => {
  // standard→plan carries an enter notice; standard→lite would queue no
  // transition notice at all (lite has no workflow text), so plan exercises
  // both notice producers in one batch.
  let activeProfileId = 'builtin:standard';
  const { service, conversationService } = makeService({
    get: vi.fn((key: string) =>
      key === 'app.activeProfileId' ? activeProfileId : key === 'agent.modelSelection' ? { model: { model: 'current-model', provider: 'openai' }, provider: 'openai' } : false,
    ),
    setDynamicTransaction: vi.fn((changes: readonly { key: string; value: unknown }[]) => {
      for (const change of changes) {
        if (change.key === 'app.activeProfileId') activeProfileId = String(change.value);
      }
    }),
    getDynamic: vi.fn((key: string) => (key === 'tools.fileWrite.enabled' ? true : false)),
  });

  service.apply([
    { key: 'app.activeProfileId', value: 'builtin:plan', persistence: 'runtime' },
    { key: 'tools.fileWrite.enabled', value: false, persistence: 'runtime' },
  ]);

  // The profile transition queues its own notice; the toggle warning must be a
  // separate composed call, not a replacement for the transition notice.
  expect(conversationService.queueModeNotice).toHaveBeenCalledTimes(2);
  const queued = conversationService.queueModeNotice.mock.calls.map((call) => call[0] as string);
  expect(queued.some((text) => text.includes('tools.fileWrite.enabled'))).toBe(true);
  expect(queued.some((text) => text !== queued.find((t) => t.includes('tools.fileWrite.enabled')))).toBe(true);
});

it('warns on capability toggle applied before workflow-profile switch in reverse order', () => {
  let activeProfileId = 'builtin:standard';
  const { service, conversationService } = makeService({
    get: vi.fn((key: string) =>
      key === 'app.activeProfileId' ? activeProfileId : key === 'agent.modelSelection' ? { model: { model: 'current-model', provider: 'openai' }, provider: 'openai' } : false,
    ),
    setDynamicTransaction: vi.fn((changes: readonly { key: string; value: unknown }[]) => {
      for (const change of changes) {
        if (change.key === 'app.activeProfileId') activeProfileId = String(change.value);
      }
    }),
    getDynamic: vi.fn((key: string) => (key === 'tools.fileWrite.enabled' ? true : false)),
  });

  service.apply([
    { key: 'tools.fileWrite.enabled', value: false, persistence: 'runtime' },
    { key: 'app.activeProfileId', value: 'builtin:plan', persistence: 'runtime' },
  ]);

  expect(conversationService.queueModeNotice).toHaveBeenCalledTimes(2);
  const queued = conversationService.queueModeNotice.mock.calls.map((call) => call[0] as string);
  expect(queued.some((text) => text.includes('tools.fileWrite.enabled'))).toBe(true);
  expect(queued.some((text) => text !== queued.find((t) => t.includes('tools.fileWrite.enabled')))).toBe(true);
});

it('maps legacy mode changes in transaction order', () => {
  let activeProfileId = 'builtin:standard';
  const { service, settingsService } = makeService({
    get: vi.fn((key: string) => (key === 'app.activeProfileId' ? activeProfileId : { model: 'gpt-4o', provider: 'openai' })),
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
