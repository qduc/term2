import React, { act } from 'react';
import { expect, it, vi } from 'vitest';
import { InputProvider, useInputState } from '../../context/InputContext.js';
import { createMockSettingsService } from '../../services/settings/settings-service.mock.js';
import { renderInAct } from '../../test-helpers/ink-testing.js';
import { useSettingsValueCompletion } from '../../hooks/use-settings-value-completion.js';
import type { SlashCommand } from '../../slash-commands.js';
import type { IntentResult } from './menu-types.js';
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

const effortCommand: SlashCommand = {
  name: 'effort',
  description: 'Reasoning effort',
  expectsArgs: true,
  completion: { type: 'setting-value', trigger: '/effort ', settingKey: 'agent.reasoningEffort' },
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
  const settingsValue = useSettingsValueCompletion(settingsService);
  return (
    <MenuStackHost
      stack={controller.getSnapshot().stack}
      controller={controller}
      interactions={controller.getInteractionRegistry()}
      services={{ settingsValue, settingsService }}
    />
  );
};

const buildController = (
  intentHost: (event: { intentRequest: any }) => Promise<IntentResult> | IntentResult | void,
  enabledRuleIds = ['settings', 'settings-value-child', 'settings-model'],
) => {
  const controller = new MenuControllerImpl({ intentHost });
  controller.setTriggerRegistry(createDefaultTriggerRegistry([settingsCommand, effortCommand], enabledRuleIds));
  return controller;
};

it('accepting a typed numeric value issues an apply-settings intent and closes through the settings-list Back on success', async () => {
  const intentHost = vi.fn(
    ({ intentRequest }): IntentResult => ({
      id: intentRequest.id,
      sourceFrameId: intentRequest.sourceFrameId,
      ok: true,
    }),
  );
  const controller = buildController(intentHost);
  const settingsService = createMockSettingsService({ 'shell.timeout': 120000 });

  await renderInAct(
    <InputProvider controller={controller}>
      <ControllerHost controller={controller} settingsService={settingsService} />
    </InputProvider>,
  );

  await act(async () => {
    controller.applyEditorEdit({ type: 'set-text', text: '/settings shell.timeout 60000', cursor: 30 });
    await Promise.resolve();
  });

  const child = controller.getSnapshot().stack.at(-1);
  expect(child?.kind).toBe('settings_value');

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
    await Promise.resolve();
  });

  expect(intentHost).toHaveBeenCalledTimes(1);
  const call = intentHost.mock.calls[0]?.[0];
  expect(call.intentRequest.intent).toEqual({
    type: 'apply-settings',
    changes: [{ key: 'shell.timeout', value: 60000, persistence: 'runtime' }],
  });
  // Success closes through the origin's Back — a passively-typed activation
  // restores the bare settings prefix.
  expect(controller.getSnapshot().stack).toHaveLength(0);
  expect(controller.getSnapshot().editor).toMatchObject({ text: SETTINGS_TRIGGER, cursor: SETTINGS_TRIGGER.length });
});

it('preselects the current thinking effort in the value menu', async () => {
  const controller = buildController(vi.fn(), ['direct-setting-value']);
  const settingsService = createMockSettingsService({ 'agent.reasoningEffort': 'high' });

  const { lastFrame } = await renderInAct(
    <InputProvider controller={controller}>
      <ControllerHost controller={controller} settingsService={settingsService} />
    </InputProvider>,
  );

  await act(async () => {
    controller.applyEditorEdit({ type: 'set-text', text: '/effort ', cursor: 8 });
    await Promise.resolve();
    await Promise.resolve();
  });

  const frame = lastFrame();
  expect(frame).toContain('▶ high');
  expect(frame).not.toContain('▶ default');
});

it('a field-error IntentResult keeps the frame open and reports the error without reopening or reconstructing it', async () => {
  const intentHost = vi.fn(
    ({ intentRequest }): IntentResult => ({
      id: intentRequest.id,
      sourceFrameId: intentRequest.sourceFrameId,
      ok: false,
      message: 'invalid value',
      fieldErrors: { 'shell.timeout': 'must be a positive number' },
    }),
  );
  const controller = buildController(intentHost);
  const settingsService = createMockSettingsService({ 'shell.timeout': 120000 });

  await renderInAct(
    <InputProvider controller={controller}>
      <ControllerHost controller={controller} settingsService={settingsService} />
    </InputProvider>,
  );

  await act(async () => {
    controller.applyEditorEdit({ type: 'set-text', text: '/settings shell.timeout -5', cursor: 27 });
    await Promise.resolve();
  });

  const child = controller.getSnapshot().stack.at(-1);
  expect(child?.kind).toBe('settings_value');

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
    await Promise.resolve();
  });

  expect(intentHost).toHaveBeenCalledTimes(1);
  // The frame stays mounted — no reopening or reconstruction.
  expect(controller.getSnapshot().stack).toHaveLength(1);
  expect(controller.getSnapshot().stack[0]?.id).toBe(child?.id);
});

it('the reset command fires a typed reset-setting intent', async () => {
  const intentHost = vi.fn(
    ({ intentRequest }): IntentResult => ({
      id: intentRequest.id,
      sourceFrameId: intentRequest.sourceFrameId,
      ok: true,
    }),
  );
  const controller = buildController(intentHost);
  const settingsService = createMockSettingsService({ 'shell.timeout': 60000 });

  await renderInAct(
    <InputProvider controller={controller}>
      <ControllerHost controller={controller} settingsService={settingsService} />
    </InputProvider>,
  );

  await act(async () => {
    controller.applyEditorEdit({ type: 'set-text', text: '/settings shell.timeout ', cursor: 25 });
    await Promise.resolve();
  });

  await act(async () => {
    controller.dispatchActiveEvent({ type: 'command', command: 'reset' });
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(intentHost).toHaveBeenCalledTimes(1);
  const call = intentHost.mock.calls[0]?.[0];
  expect(call.intentRequest.intent).toEqual({ type: 'reset-setting', key: 'shell.timeout' });
  expect(controller.getSnapshot().stack).toHaveLength(0);
});

it('Tab inserts the selected suggestion without submitting or closing the frame', async () => {
  const intentHost = vi.fn();
  const controller = buildController(intentHost);
  const settingsService = createMockSettingsService({ 'shell.timeout': 120000 });

  await renderInAct(
    <InputProvider controller={controller}>
      <ControllerHost controller={controller} settingsService={settingsService} />
    </InputProvider>,
  );

  await act(async () => {
    controller.applyEditorEdit({ type: 'set-text', text: '/settings shell.timeout ', cursor: 25 });
    await Promise.resolve();
  });

  await act(async () => {
    controller.dispatchActiveEvent({ type: 'command', command: 'tab' });
    await Promise.resolve();
  });

  expect(intentHost).not.toHaveBeenCalled();
  expect(controller.getSnapshot().stack).toHaveLength(1);
  expect(controller.getSnapshot().editor.text.startsWith('/settings shell.timeout ')).toBe(true);
  expect(controller.getSnapshot().editor.text.length).toBeGreaterThan(25);
});
