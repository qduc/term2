// @ts-expect-error IS_REACT_ACT_ENVIRONMENT is not in globalThis types
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import React, { useEffect } from 'react';
import { act } from 'react';
import { it, expect, vi } from 'vitest';
import { Text } from 'ink';
import { InputProvider } from '../../context/InputContext.js';
import { MenuControllerImpl } from './menu-controller.js';
import ApplicationInputSurface from './ApplicationInputSurface.js';
import { createMockSettingsService } from '../../services/settings/settings-service.mock.js';
import type { LoggingService } from '../../services/logging/logging-service.js';
import type { HistoryService } from '../../services/history-service.js';
import type { SlashCommand } from '../../slash-commands.js';
import { renderInAct } from '../../test-helpers/ink-testing.js';

const inputBoxMounts = { mounted: 0, unmounted: 0 };

vi.mock('../InputBox.js', () => ({
  default: function MockInputBox() {
    useEffect(() => {
      inputBoxMounts.mounted += 1;
      return () => {
        inputBoxMounts.unmounted += 1;
      };
    }, []);
    return <Text>INPUT_BOX</Text>;
  },
}));

const loggingService = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  security: () => {},
  setCorrelationId: () => {},
  getCorrelationId: () => undefined,
  clearCorrelationId: () => {},
} as unknown as LoggingService;

const historyService = {
  getMessages: () => [],
  getTurns: () => [],
  addMessage: () => {},
  clear: () => {},
} as unknown as HistoryService;

const slashCommands: SlashCommand[] = [{ name: '/clear', description: 'Clear', action: () => {} }];

const renderSurface = async (controller: MenuControllerImpl) => {
  const result = await renderInAct(
    <InputProvider controller={controller}>
      <ApplicationInputSurface
        enabled
        onSubmit={async () => {}}
        slashCommands={slashCommands}
        settingsService={createMockSettingsService()}
        loggingService={loggingService}
        historyService={historyService}
      />
    </InputProvider>,
  );
  return result;
};

const waitForInputSurface = async (predicate: () => boolean, description: string): Promise<void> => {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}.`);
    await act(async () => {
      await new Promise((resolve) => setImmediate(resolve));
    });
  }
};

it.sequential('routes Escape through the active slash session and clears the trigger buffer', async () => {
  const controller = new MenuControllerImpl();
  const { stdin } = await renderSurface(controller);

  await act(async () => {
    controller.applyEditorEdit({ type: 'set-text', text: '/', cursor: 1 });
  });
  await waitForInputSurface(() => controller.getSnapshot().stack.at(-1)?.kind === 'slash', 'slash menu open');

  expect(controller.getSnapshot().stack.at(-1)?.kind).toBe('slash');

  await act(async () => {
    stdin.write('\u001b');
  });
  await waitForInputSurface(
    () => controller.getSnapshot().stack.length === 0 && controller.getSnapshot().editor.text === '',
    'slash menu close',
  );

  expect(controller.getSnapshot().stack).toHaveLength(0);
  expect(controller.getSnapshot().editor.text).toBe('');
});

it.sequential('unmounts InputBox while a menu is visible and restores the empty stack after close', async () => {
  inputBoxMounts.mounted = 0;
  inputBoxMounts.unmounted = 0;
  const controller = new MenuControllerImpl();
  const { lastFrame, unmount } = await renderSurface(controller);

  expect(lastFrame()).toContain('INPUT_BOX');
  expect(inputBoxMounts.mounted).toBe(1);

  act(() => {
    controller.open({
      kind: 'rewind',
      items: [{ id: 'message-1', preview: 'message', timestamp: 'now' } as any],
      initialDisposition: 'edit',
    });
  });
  await waitForInputSurface(
    () => !(lastFrame() ?? '').includes('INPUT_BOX') && inputBoxMounts.unmounted === 1,
    'rewind menu open',
  );

  expect(lastFrame()).not.toContain('INPUT_BOX');
  expect(inputBoxMounts.unmounted).toBe(1);

  await act(async () => controller.close());
  await waitForInputSurface(
    () => controller.getSnapshot().stack.length === 0 && inputBoxMounts.unmounted === 1,
    'rewind menu close',
  );

  expect(controller.getSnapshot().stack).toHaveLength(0);
  expect(inputBoxMounts.unmounted).toBe(1);
  act(() => unmount());
});
