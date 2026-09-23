// @ts-expect-error IS_REACT_ACT_ENVIRONMENT is not in globalThis types
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import React, { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { InputProvider } from '../../context/InputContext.js';
import { createMockSettingsService } from '../../services/settings/settings-service.mock.js';
import { renderInAct } from '../../test-helpers/ink-testing.js';
import { useModelSelection } from '../../hooks/use-model-selection.js';
import { registerProvider, unregisterProvider } from '../../providers/index.js';
import { clearModelCache } from '../../services/model-service.js';
import type { SlashCommand } from '../../slash-commands.js';
import type { useSlashCommands } from '../../hooks/use-slash-commands.js';
import type { IntentResult } from './menu-types.js';
import { MenuStackHost } from './MenuStackHost.js';
import { MenuControllerImpl } from './menu-controller.js';
import { createDefaultTriggerRegistry, SETTINGS_TRIGGER, SETTINGS_RESET_TRIGGER } from './triggers.js';
import { createSlashMenuInteraction } from './SlashMenuSession.js';
import {
  SLASH_MENU_BINDINGS,
  MODEL_MENU_BINDINGS,
  MODEL_MENU_NICKNAME_DRAFT_BINDINGS,
  type MenuBinding,
} from './menu-bindings.js';

// Parity between the declared binding tables and the behavior the owning
// sessions implement: each advertised binding must actually do what its
// footer hint promises. A binding added to a table without a parity outcome
// fails here, and a session change that breaks an advertised action fails
// here, so the tables cannot silently drift from behavior.

// ---------------------------------------------------------------------------
// Slash frame (pure unit against createSlashMenuInteraction).
// ---------------------------------------------------------------------------

const makeCommand = (name: string, overrides: Partial<SlashCommand> = {}): SlashCommand => ({
  name,
  description: `${name} command`,
  action: () => true,
  ...overrides,
});

const makeSlashState = (overrides: Partial<ReturnType<typeof useSlashCommands>> = {}) =>
  ({
    filteredCommands: [],
    selectedIndex: 0,
    scrollOffset: 0,
    moveUp: vi.fn(),
    moveDown: vi.fn(),
    moveHome: vi.fn(),
    moveEnd: vi.fn(),
    pageUp: vi.fn(),
    pageDown: vi.fn(),
    getSelectedItem: () => undefined,
    executeSelected: vi.fn(),
    ...overrides,
  } as unknown as ReturnType<typeof useSlashCommands>);

const openSlashFrame = (commands: SlashCommand[]) => {
  const controller = new MenuControllerImpl({ triggerRegistry: createDefaultTriggerRegistry(commands) });
  controller.applyEditorEdit({ type: 'set-text', text: '/', cursor: 1 });
  const frame = controller.getSnapshot().stack.at(-1);
  if (!frame || frame.kind !== 'slash') throw new Error('expected an open slash frame');
  return { controller, frame };
};

const slashParityOutcomes: Record<
  string,
  (api: { controller: MenuControllerImpl; slash: ReturnType<typeof makeSlashState> }) => void
> = {
  '↑↓': ({ controller, slash }) => {
    controller.dispatchActiveEvent({ type: 'move', direction: 'up' });
    expect(slash.moveUp).toHaveBeenCalledTimes(1);
    controller.dispatchActiveEvent({ type: 'move', direction: 'down' });
    expect(slash.moveDown).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().stack).toHaveLength(1);
  },
  '⏎': ({ controller, slash }) => {
    controller.dispatchActiveEvent({
      type: 'accept',
      input: { kind: 'composer', text: '/', cursor: 1 },
      selected: undefined,
    });
    expect(slash.executeSelected).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().stack).toHaveLength(0);
  },
  Tab: ({ controller, slash }) => {
    const action = vi.fn(() => true);
    const command = makeCommand('clear', { action });
    slash.getSelectedItem = () => command;
    controller.dispatchActiveEvent({ type: 'command', command: 'tab' });
    expect(controller.getSnapshot().editor.text).toBe('/clear ');
    expect(controller.getSnapshot().stack).toHaveLength(0);
    expect(action).not.toHaveBeenCalled();
  },
  esc: ({ controller }) => {
    controller.dispatchActiveEvent({ type: 'escape' });
    expect(controller.getSnapshot().editor.text).toBe('');
    expect(controller.getSnapshot().stack).toHaveLength(0);
  },
};

for (const binding of SLASH_MENU_BINDINGS) {
  it(`slash binding "${binding.key} ${binding.action}" behaves as advertised`, () => {
    const outcome = slashParityOutcomes[binding.key];
    expect(outcome, `slash binding "${binding.key}" has no parity outcome`).toBeDefined();
    const command = makeCommand('clear', { action: vi.fn(() => true) });
    const { controller, frame } = openSlashFrame([command]);
    const slash = makeSlashState();
    controller.getInteractionRegistry().register(frame.id, createSlashMenuInteraction(controller, slash));
    outcome({ controller, slash });
  });
}

// ---------------------------------------------------------------------------
// Model frame (rendered harness against ModelMenuSession's interaction).
// ---------------------------------------------------------------------------

const noopLoggingService = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  security: () => {},
  setCorrelationId: () => {},
  getCorrelationId: () => undefined,
  clearCorrelationId: () => {},
} as any;

const settingsCommand: SlashCommand = {
  name: 'settings',
  description: 'Settings',
  expectsArgs: true,
  completion: { type: 'settings', trigger: SETTINGS_TRIGGER, resetTrigger: SETTINGS_RESET_TRIGGER },
  action: () => {},
};

const modelCommand: SlashCommand = {
  name: 'model',
  description: 'Model',
  expectsArgs: true,
  completion: { type: 'model', trigger: '/model ' },
  action: () => {},
};

let providerId = '';

beforeEach(() => {
  vi.stubEnv('OPENAI_API_KEY', '');
  vi.stubEnv('OPENROUTER_API_KEY', '');
  clearModelCache();
  providerId = `mock-provider-${Date.now()}-${Math.random()}`;
  registerProvider({
    id: providerId,
    label: 'Mock Provider',
    fetchModels: async () => [{ id: 'gpt-test', name: 'GPT Test' }],
  });
});

afterEach(() => {
  unregisterProvider(providerId);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

type ModelApi = {
  controller: MenuControllerImpl;
  view: Awaited<ReturnType<typeof renderInAct>>;
  settingsService: ReturnType<typeof createMockSettingsService>;
  intentHost: ReturnType<typeof vi.fn>;
  fetcher: ReturnType<typeof vi.fn>;
};

const openModelFrame = async (settingsOverrides: Record<string, unknown> = {}): Promise<ModelApi> => {
  const intentHost = vi.fn(
    ({ intentRequest }): IntentResult => ({
      id: intentRequest.id,
      sourceFrameId: intentRequest.sourceFrameId,
      ok: true,
    }),
  );
  const fetcher = vi.fn(async (provider: string) =>
    provider === providerId
      ? [
          { id: 'gpt-test', name: 'GPT Test', provider: providerId },
          { id: 'zebra-test', name: 'Zebra Test', provider: providerId },
        ]
      : [],
  );
  const controller = new MenuControllerImpl({ intentHost });
  controller.setTriggerRegistry(
    createDefaultTriggerRegistry(
      [settingsCommand, modelCommand],
      ['settings', 'settings-value-child', 'settings-model', 'command-model'],
    ),
  );
  const settingsService = createMockSettingsService({
    'agent.provider': providerId,
    ...settingsOverrides,
  });

  const ControllerHost = () => {
    const models = useModelSelection({
      loggingService: noopLoggingService,
      settingsService,
      modelFetcher: fetcher,
    });
    return (
      <MenuStackHost
        stack={controller.getSnapshot().stack}
        controller={controller}
        interactions={controller.getInteractionRegistry()}
        services={{ models, settingsService }}
      />
    );
  };

  const view = await renderInAct(
    <InputProvider controller={controller}>
      <ControllerHost />
    </InputProvider>,
  );

  await act(async () => {
    controller.applyEditorEdit({ type: 'set-text', text: '/model ', cursor: 7 });
    await Promise.resolve();
  });
  await act(async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });
  expect(controller.getSnapshot().stack.at(-1)?.kind).toBe('model');
  return { controller, view, settingsService, intentHost, fetcher };
};

const dispatch = async (
  controller: MenuControllerImpl,
  event: Parameters<MenuControllerImpl['dispatchActiveEvent']>[0],
) => {
  await act(async () => {
    controller.dispatchActiveEvent(event);
    await Promise.resolve();
  });
};

const modelParityOutcomes: Record<string, (api: ModelApi) => Promise<void>> = {
  '↑↓': async ({ controller, view }) => {
    expect(view.lastFrame()).toContain('❯ gpt-test');
    await dispatch(controller, { type: 'move', direction: 'down' });
    expect(view.lastFrame()).toContain('❯ zebra-test');
    await dispatch(controller, { type: 'move', direction: 'up' });
    expect(view.lastFrame()).toContain('❯ gpt-test');
  },
  '⏎': async ({ controller, intentHost }) => {
    await dispatch(controller, {
      type: 'accept',
      input: { kind: 'composer', text: '/model ', cursor: 7 },
      selected: undefined,
    });
    expect(intentHost).toHaveBeenCalledTimes(1);
    expect(intentHost.mock.calls[0]?.[0].intentRequest.intent).toEqual({
      type: 'submit-prompt',
      text: expect.stringContaining('gpt-test'),
    });
  },
  'Tab/←→': async ({ controller, view }) => {
    await dispatch(controller, { type: 'command', command: 'left' });
    expect(view.lastFrame()).toContain('No nicknames yet');
    expect(controller.getSnapshot().editor.text).toBe('/model ');

    await dispatch(controller, { type: 'command', command: 'right' });
    expect(view.lastFrame()).toMatch(/gpt-test/);
    await dispatch(controller, { type: 'command', command: 'tab' });
    expect(view.lastFrame()).toContain('No favorites yet');
  },
  'ctrl+n': async ({ controller, view }) => {
    await dispatch(controller, { type: 'command', command: 'nickname' });
    expect(view.lastFrame()).toContain('Nickname for gpt-test:');
  },
  'ctrl+f': async ({ controller, settingsService }) => {
    expect(settingsService.get('agent.favoriteModels')).toEqual([]);
    await dispatch(controller, { type: 'command', command: 'favorite' });
    expect(settingsService.get('agent.favoriteModels')).toEqual([`${providerId}/gpt-test`]);
    await dispatch(controller, { type: 'command', command: 'favorite' });
    expect(settingsService.get('agent.favoriteModels')).toEqual([]);
  },
  'ctrl+r': async ({ controller, fetcher }) => {
    const before = fetcher.mock.calls.length;
    await dispatch(controller, { type: 'command', command: 'refresh' });
    expect(fetcher.mock.calls.length).toBeGreaterThan(before);
  },
  esc: async ({ controller }) => {
    await dispatch(controller, { type: 'escape' });
    expect(controller.getSnapshot().stack).toHaveLength(0);
  },
};

for (const binding of MODEL_MENU_BINDINGS) {
  it(`model binding "${binding.key} ${binding.action}" behaves as advertised`, async () => {
    const outcome = modelParityOutcomes[binding.key];
    expect(outcome, `model binding "${binding.key}" has no parity outcome`).toBeDefined();
    const api = await openModelFrame(
      binding.key === 'ctrl+n' ? { 'agent.favoriteModels': [`${providerId}/gpt-test`] } : {},
    );
    await outcome(api);
  });
}

// The nickname-draft table is advertised while the draft editor owns the
// input row: save commits the draft, cancel dismisses it.
const draftParityOutcomes: Record<string, (api: ModelApi) => Promise<void>> = {
  '⏎': async ({ controller, view }) => {
    await dispatch(controller, { type: 'input', text: 'op' });
    await dispatch(controller, {
      type: 'accept',
      input: { kind: 'transient', text: 'op', cursor: 2, sensitive: false },
      selected: undefined,
    });
    expect(view.lastFrame()).toContain('aka "op"');
    expect(view.lastFrame()).not.toContain('Nickname for');
  },
  esc: async ({ controller, view }) => {
    await dispatch(controller, { type: 'escape' });
    expect(view.lastFrame()).not.toContain('Nickname for');
    // Cancel returns to the untouched list row rather than closing the menu.
    expect(controller.getSnapshot().stack.at(-1)?.kind).toBe('model');
  },
};

for (const binding of MODEL_MENU_NICKNAME_DRAFT_BINDINGS) {
  it(`model draft binding "${binding.key} ${binding.action}" behaves as advertised`, async () => {
    const outcome = draftParityOutcomes[binding.key];
    expect(outcome, `draft binding "${binding.key}" has no parity outcome`).toBeDefined();
    const api = await openModelFrame({ 'agent.favoriteModels': [`${providerId}/gpt-test`] });
    await dispatch(api.controller, { type: 'command', command: 'nickname' });
    expect(api.view.lastFrame()).toContain('Nickname for gpt-test:');
    await outcome(api);
  });
}
