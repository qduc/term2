import React, { act } from 'react';
import { expect, it, vi } from 'vitest';
import { InputProvider, useInputState } from '../../context/InputContext.js';
import { createMockSettingsService } from '../../services/settings/settings-service.mock.js';
import { renderInAct } from '../../test-helpers/ink-testing.js';
import { useSettingsCompletion } from '../../hooks/use-settings-completion.js';
import type { SlashCommand } from '../../slash-commands.js';
import type { IntentHost } from './menu-types.js';
import { MenuStackHost } from './MenuStackHost.js';
import { MenuControllerImpl } from './menu-controller.js';
import { createDefaultTriggerRegistry, SETTINGS_TRIGGER, SETTINGS_RESET_TRIGGER } from './triggers.js';

const settingsCommand: SlashCommand = {
  name: 'settings',
  description: 'Settings',
  expectsArgs: true,
  completion: { type: 'settings', trigger: SETTINGS_TRIGGER, resetTrigger: SETTINGS_RESET_TRIGGER },
  action: () => {},
};

const ControllerHost = ({
  controller,
  settingsService,
}: {
  controller: MenuControllerImpl;
  settingsService: ReturnType<typeof createMockSettingsService>;
}) => {
  const { input: _input } = useInputState();
  const settings = useSettingsCompletion(settingsService);
  return (
    <MenuStackHost
      stack={controller.getSnapshot().stack}
      controller={controller}
      interactions={controller.getInteractionRegistry()}
      services={{ settings, settingsService }}
    />
  );
};

const buildController = (intentHost?: IntentHost) => {
  const controller = new MenuControllerImpl({ intentHost });
  controller.setTriggerRegistry(
    createDefaultTriggerRegistry([settingsCommand], ['settings', 'settings-value-child', 'settings-model']),
  );
  return controller;
};

it('selecting a plain key pushes a settings_value child as one transaction, restoring the pre-selection filter on Escape', async () => {
  const controller = buildController();
  const settingsService = createMockSettingsService();

  await renderInAct(
    <InputProvider controller={controller}>
      <ControllerHost controller={controller} settingsService={settingsService} />
    </InputProvider>,
  );

  await act(async () => {
    controller.applyEditorEdit({ type: 'set-text', text: '/settings shell.time', cursor: 20 });
    await Promise.resolve();
  });

  const parent = controller.getSnapshot().stack.at(-1);
  expect(parent?.kind).toBe('settings');

  await act(async () => {
    controller.dispatchActiveEvent({
      type: 'accept',
      input: {
        kind: 'composer',
        text: controller.getSnapshot().editor.text,
        cursor: controller.getSnapshot().editor.cursor,
      },
      selected: undefined,
    });
    await Promise.resolve();
  });

  const child = controller.getSnapshot().stack.at(-1);
  expect(child?.kind).toBe('settings_value');
  if (child?.kind !== 'settings_value') throw new Error('expected settings_value child');
  expect(child.settingKey).toBe('shell.timeout');
  expect(child.origin).toEqual({
    type: 'settings-list',
    operation: 'set',
    back: { type: 'restore', point: { editor: { text: '/settings shell.time', cursor: 20, revision: 2 } } },
  });
  expect(controller.getSnapshot().editor).toMatchObject({ text: '/settings shell.timeout ', cursor: 24 });

  // Escape restores the exact pre-selection filter (the explicit-selection
  // Back preserves what the user had typed, unlike a passively-typed
  // activation which restores the bare prefix — see triggers.test.ts).
  await act(async () => {
    controller.escape();
    await Promise.resolve();
  });

  expect(controller.getSnapshot().stack).toHaveLength(1);
  expect(controller.getSnapshot().stack[0]?.kind).toBe('settings');
  expect(controller.getSnapshot().editor).toMatchObject({ text: '/settings shell.time', cursor: 20 });
});

it('selecting a model-backed key pushes a settings-backed model child instead of a settings_value child', async () => {
  const controller = buildController();
  const settingsService = createMockSettingsService({ 'agent.provider': 'openai' });

  await renderInAct(
    <InputProvider controller={controller}>
      <ControllerHost controller={controller} settingsService={settingsService} />
    </InputProvider>,
  );

  await act(async () => {
    controller.applyEditorEdit({ type: 'set-text', text: '/settings agent.mo', cursor: 18 });
    await Promise.resolve();
  });

  await act(async () => {
    controller.dispatchActiveEvent({
      type: 'accept',
      input: {
        kind: 'composer',
        text: controller.getSnapshot().editor.text,
        cursor: controller.getSnapshot().editor.cursor,
      },
      selected: undefined,
    });
    await Promise.resolve();
  });

  const child = controller.getSnapshot().stack.at(-1);
  expect(child?.kind).toBe('model');
  if (child?.kind !== 'model') throw new Error('expected model child');
  expect(child.target).toEqual({
    type: 'setting',
    config: { modelKey: 'agent.model', providerKey: 'agent.provider', fallbackProviderKey: undefined },
  });
  expect(child.back).toEqual({
    type: 'restore',
    point: { editor: { text: '/settings agent.mo', cursor: 18, revision: 2 } },
  });
});

it('reset operation completes the typed key on a first accept, then confirms via a typed reset-setting intent', async () => {
  const intentHost = vi.fn();
  const controller = buildController(intentHost);
  const settingsService = createMockSettingsService({ 'shell.timeout': 30000 });

  await renderInAct(
    <InputProvider controller={controller}>
      <ControllerHost controller={controller} settingsService={settingsService} />
    </InputProvider>,
  );

  await act(async () => {
    controller.applyEditorEdit({ type: 'set-text', text: '/settings reset shell.time', cursor: 27 });
    await Promise.resolve();
  });

  const frameBefore = controller.getSnapshot().stack.at(-1);
  expect(frameBefore?.kind).toBe('settings');
  if (frameBefore?.kind === 'settings') expect(frameBefore.operation).toBe('reset');

  // First accept: completes the key text, stays in reset mode, never pushes
  // a settings_value frame or rewrites the prefix to /settings .
  await act(async () => {
    controller.dispatchActiveEvent({
      type: 'accept',
      input: {
        kind: 'composer',
        text: controller.getSnapshot().editor.text,
        cursor: controller.getSnapshot().editor.cursor,
      },
      selected: undefined,
    });
    await Promise.resolve();
  });

  expect(controller.getSnapshot().stack).toHaveLength(1);
  expect(controller.getSnapshot().stack[0]?.kind).toBe('settings');
  expect(controller.getSnapshot().editor.text).toBe('/settings reset shell.timeout ');
  expect(intentHost).not.toHaveBeenCalled();

  // Second accept: the query now exactly names a valid key, so this
  // confirms the reset as a typed intent.
  await act(async () => {
    controller.dispatchActiveEvent({
      type: 'accept',
      input: {
        kind: 'composer',
        text: controller.getSnapshot().editor.text,
        cursor: controller.getSnapshot().editor.cursor,
      },
      selected: undefined,
    });
    await Promise.resolve();
  });

  expect(intentHost).toHaveBeenCalledTimes(1);
  const call = intentHost.mock.calls[0]?.[0];
  expect(call.intentRequest.intent).toEqual({ type: 'reset-setting', key: 'shell.timeout' });
  expect(controller.getSnapshot().stack).toHaveLength(0);
});

it('Escape closes the settings list without reopening (no dismissed-activation leak)', async () => {
  const controller = buildController();
  const settingsService = createMockSettingsService();

  await renderInAct(
    <InputProvider controller={controller}>
      <ControllerHost controller={controller} settingsService={settingsService} />
    </InputProvider>,
  );

  await act(async () => {
    controller.applyEditorEdit({ type: 'set-text', text: '/settings shel', cursor: 14 });
    await Promise.resolve();
  });
  expect(controller.getSnapshot().stack).toHaveLength(1);

  await act(async () => {
    controller.escape();
    await Promise.resolve();
  });
  expect(controller.getSnapshot().stack).toHaveLength(0);

  // Typing more query text under the same activation does not reopen it.
  await act(async () => {
    controller.applyEditorEdit({ type: 'set-text', text: '/settings shell', cursor: 15 });
    await Promise.resolve();
  });
  expect(controller.getSnapshot().stack).toHaveLength(0);
});
