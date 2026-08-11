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
    createDefaultTriggerRegistry(
      [settingsCommand],
      ['settings', 'settings-value-child', 'settings-mentor-pool-child', 'settings-model'],
    ),
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

it('selecting agent.mentorPool opens the structured mentor pool editor and saves its array through apply-settings', async () => {
  const intentHost = vi.fn(({ intentRequest }) => ({
    id: intentRequest.id,
    sourceFrameId: intentRequest.sourceFrameId,
    ok: true as const,
  }));
  const controller = buildController(intentHost);
  const settingsService = createMockSettingsService({ 'agent.mentorPool': [] });

  await renderInAct(
    <InputProvider controller={controller}>
      <ControllerHost controller={controller} settingsService={settingsService} />
    </InputProvider>,
  );

  await act(async () => {
    controller.applyEditorEdit({ type: 'set-text', text: '/settings agent.mentorPo', cursor: 25 });
    await Promise.resolve();
  });
  await act(async () => {
    controller.dispatchActiveEvent({
      type: 'accept',
      input: { kind: 'composer', text: controller.getSnapshot().editor.text, cursor: 25 },
      selected: undefined,
    });
    await Promise.resolve();
  });

  expect(controller.getSnapshot().stack.at(-1)?.kind).toBe('mentor_pool');
  await act(async () => {
    controller.escape();
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  expect(intentHost).toHaveBeenCalledTimes(1);
  expect(intentHost.mock.calls[0]?.[0].intentRequest.intent).toEqual({
    type: 'apply-settings',
    changes: [{ key: 'agent.mentorPool', value: [], persistence: 'runtime' }],
  });
  expect(controller.getSnapshot().stack).toHaveLength(1);
  expect(controller.getSnapshot().stack[0]?.kind).toBe('settings');
});

it('opens the model editor for a new mentor pool entry without exceeding the React update depth', async () => {
  const controller = buildController();
  const settingsService = createMockSettingsService({ 'agent.mentorPool': [] });

  const view = await renderInAct(
    <InputProvider controller={controller}>
      <ControllerHost controller={controller} settingsService={settingsService} />
    </InputProvider>,
  );

  await act(async () => {
    controller.applyEditorEdit({ type: 'set-text', text: '/settings agent.mentorPool', cursor: 26 });
    await Promise.resolve();
    controller.dispatchActiveEvent({
      type: 'accept',
      input: { kind: 'composer', text: controller.getSnapshot().editor.text, cursor: 26 },
      selected: undefined,
    });
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

  expect(view.lastFrame()).toContain('Enter Model ID');
});

it.skip('edits an entry model locally before persisting the complete pool', async () => {
  const intentHost = vi.fn(({ intentRequest }) => ({
    id: intentRequest.id,
    sourceFrameId: intentRequest.sourceFrameId,
    ok: true as const,
  }));
  const controller = buildController(intentHost);
  const settingsService = createMockSettingsService({
    'agent.mentorPool': [{ model: 'old-model', provider: 'openai', reasoningEffort: 'high' }],
  });

  const view = await renderInAct(
    <InputProvider controller={controller}>
      <ControllerHost controller={controller} settingsService={settingsService} />
    </InputProvider>,
  );
  await act(async () => {
    controller.applyEditorEdit({ type: 'set-text', text: '/settings agent.mentorPool', cursor: 26 });
    await Promise.resolve();
    controller.dispatchActiveEvent({
      type: 'accept',
      input: { kind: 'composer', text: controller.getSnapshot().editor.text, cursor: 26 },
      selected: undefined,
    });
    await Promise.resolve();
  });
  expect(controller.getSnapshot().stack.at(-1)?.kind).toBe('mentor_pool');

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
  await act(async () => {
    controller.dispatchActiveEvent({
      type: 'accept',
      input: { kind: 'composer', text: 'new-model', cursor: 9 },
      selected: undefined,
    });
    await Promise.resolve();
  });
  await act(async () => {
    controller.dispatchActiveEvent({ type: 'move', direction: 'down' });
    controller.dispatchActiveEvent({ type: 'move', direction: 'down' });
    controller.dispatchActiveEvent({ type: 'move', direction: 'down' });
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
  await act(async () => {
    controller.escape();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  expect(intentHost.mock.calls.at(-1)?.[0].intentRequest.intent).toEqual({
    type: 'apply-settings',
    changes: [
      {
        key: 'agent.mentorPool',
        value: [{ model: 'new-model', provider: 'openai', reasoningEffort: 'high' }],
        persistence: 'runtime',
      },
    ],
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
