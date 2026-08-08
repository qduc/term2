import React, { act } from 'react';
import { expect, it, vi, beforeEach, afterEach } from 'vitest';
import { InputProvider, useInputState } from '../../context/InputContext.js';
import { createMockSettingsService } from '../../services/settings/settings-service.mock.js';
import { renderInAct } from '../../test-helpers/ink-testing.js';
import { useModelSelection } from '../../hooks/use-model-selection.js';
import { registerProvider, unregisterProvider } from '../../providers/index.js';
import { clearModelCache } from '../../services/model-service.js';
import type { SlashCommand } from '../../slash-commands.js';
import type { IntentResult } from './menu-types.js';
import { MenuStackHost } from './MenuStackHost.js';
import { MenuControllerImpl } from './menu-controller.js';
import { createDefaultTriggerRegistry, SETTINGS_TRIGGER, SETTINGS_RESET_TRIGGER } from './triggers.js';

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

const ControllerHost = ({
  controller,
  settingsService,
}: {
  controller: MenuControllerImpl;
  settingsService: ReturnType<typeof createMockSettingsService>;
}) => {
  const { input: _input } = useInputState();
  const models = useModelSelection({ loggingService: noopLoggingService, settingsService });
  return (
    <MenuStackHost
      stack={controller.getSnapshot().stack}
      controller={controller}
      interactions={controller.getInteractionRegistry()}
      services={{ models, settingsService }}
    />
  );
};

const buildController = (
  intentHost: (event: { intentRequest: any }) => Promise<IntentResult> | IntentResult | void,
) => {
  const controller = new MenuControllerImpl({ intentHost });
  controller.setTriggerRegistry(
    createDefaultTriggerRegistry([settingsCommand], ['settings', 'settings-value-child', 'settings-model']),
  );
  return controller;
};

let providerId: string;

beforeEach(() => {
  clearModelCache();
  providerId = `mock-provider-${Date.now()}-${Math.random()}`;
  registerProvider({
    id: providerId,
    label: 'Mock Provider',
    fetchModels: async () => [{ id: 'gpt-test', name: 'GPT Test' }],
  });
});

afterEach(() => {
  clearModelCache();
  unregisterProvider(providerId);
});

it('accepting a fetched model applies the model and provider in one apply-settings intent, closing through the settings-list Back', async () => {
  const intentHost = vi.fn(
    ({ intentRequest }): IntentResult => ({
      id: intentRequest.id,
      sourceFrameId: intentRequest.sourceFrameId,
      ok: true,
    }),
  );
  const controller = buildController(intentHost);
  const settingsService = createMockSettingsService({ 'agent.provider': providerId });

  await renderInAct(
    <InputProvider controller={controller}>
      <ControllerHost controller={controller} settingsService={settingsService} />
    </InputProvider>,
  );

  await act(async () => {
    controller.applyEditorEdit({ type: 'set-text', text: '/settings agent.model ', cursor: 22 });
    await Promise.resolve();
  });

  // Wait for the async model fetch to populate the list.
  await act(async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });

  const child = controller.getSnapshot().stack.at(-1);
  expect(child?.kind).toBe('model');

  await act(async () => {
    controller.applyEditorEdit({ type: 'insert', text: 'gpt-test' });
    await Promise.resolve();
  });
  await act(async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
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
    await Promise.resolve();
  });

  expect(intentHost).toHaveBeenCalledTimes(1);
  const call = intentHost.mock.calls[0]?.[0];
  expect(call.intentRequest.intent).toEqual({
    type: 'apply-settings',
    changes: [
      { key: 'agent.model', value: 'gpt-test', persistence: 'runtime' },
      { key: 'agent.provider', value: providerId, persistence: 'runtime' },
    ],
  });
  expect(controller.getSnapshot().stack).toHaveLength(0);
  expect(controller.getSnapshot().editor).toMatchObject({ text: SETTINGS_TRIGGER, cursor: SETTINGS_TRIGGER.length });
});

it('accepting a typed custom model id (no menu item matches) still applies via the intent', async () => {
  const intentHost = vi.fn(
    ({ intentRequest }): IntentResult => ({
      id: intentRequest.id,
      sourceFrameId: intentRequest.sourceFrameId,
      ok: true,
    }),
  );
  const controller = buildController(intentHost);
  const settingsService = createMockSettingsService({ 'agent.provider': providerId });

  await renderInAct(
    <InputProvider controller={controller}>
      <ControllerHost controller={controller} settingsService={settingsService} />
    </InputProvider>,
  );

  await act(async () => {
    controller.applyEditorEdit({ type: 'set-text', text: '/settings agent.model custom-model', cursor: 35 });
    await Promise.resolve();
  });
  await act(async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
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
    await Promise.resolve();
  });

  expect(intentHost).toHaveBeenCalledTimes(1);
  const call = intentHost.mock.calls[0]?.[0];
  expect(call.intentRequest.intent).toEqual({
    type: 'apply-settings',
    changes: [
      { key: 'agent.model', value: 'custom-model', persistence: 'runtime' },
      { key: 'agent.provider', value: providerId, persistence: 'runtime' },
    ],
  });
});

it('a field-error IntentResult keeps the model frame open instead of reopening or reconstructing it', async () => {
  const intentHost = vi.fn(
    ({ intentRequest }): IntentResult => ({
      id: intentRequest.id,
      sourceFrameId: intentRequest.sourceFrameId,
      ok: false,
      message: 'Unknown model',
    }),
  );
  const controller = buildController(intentHost);
  const settingsService = createMockSettingsService({ 'agent.provider': providerId });

  await renderInAct(
    <InputProvider controller={controller}>
      <ControllerHost controller={controller} settingsService={settingsService} />
    </InputProvider>,
  );

  await act(async () => {
    controller.applyEditorEdit({ type: 'set-text', text: '/settings agent.model bogus', cursor: 27 });
    await Promise.resolve();
  });
  await act(async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });

  const child = controller.getSnapshot().stack.at(-1);

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
  expect(controller.getSnapshot().stack).toHaveLength(1);
  expect(controller.getSnapshot().stack[0]?.id).toBe(child?.id);
});

it('Tab inserts the typed model id without the provider suffix and without submitting', async () => {
  const intentHost = vi.fn();
  const controller = buildController(intentHost);
  const settingsService = createMockSettingsService({ 'agent.provider': providerId });

  await renderInAct(
    <InputProvider controller={controller}>
      <ControllerHost controller={controller} settingsService={settingsService} />
    </InputProvider>,
  );

  await act(async () => {
    controller.applyEditorEdit({ type: 'set-text', text: '/settings agent.model ', cursor: 22 });
    await Promise.resolve();
  });
  await act(async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });

  await act(async () => {
    controller.dispatchActiveEvent({ type: 'command', command: 'tab' });
    await Promise.resolve();
  });

  expect(intentHost).not.toHaveBeenCalled();
  expect(controller.getSnapshot().stack).toHaveLength(1);
  expect(controller.getSnapshot().editor.text).toBe('/settings agent.model gpt-test ');
});
