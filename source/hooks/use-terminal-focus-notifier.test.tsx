// @ts-ignore
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import { it, expect, vi } from 'vitest';
import React, { act, useEffect } from 'react';
import { useStdin } from 'ink';
import { renderInAct } from '../test-helpers/ink-testing.js';
import { createMockSettingsService } from '../services/settings/settings-service.mock.js';
import { useTerminalFocusNotifier } from './use-terminal-focus-notifier.js';

const mocks = vi.hoisted(() => ({
  sendNotification: vi.fn(),
}));

vi.mock('../services/notification-service.js', () => ({
  sendNotification: mocks.sendNotification,
}));

type TestControls = ReturnType<typeof useTerminalFocusNotifier>;

const useCaptureInputEmitter = (setEmitter: (emitter: any) => void) => {
  const stdin = useStdin() as any;

  useEffect(() => {
    setEmitter(stdin.internal_eventEmitter);
  }, [setEmitter, stdin]);
};

const renderHook = async (options: {
  stdout: { write: (value: string) => unknown };
  settingsOverrides?: Record<string, any>;
  loggingService?: { debug: (message: string, meta?: any) => void };
}) => {
  let controls: TestControls | null = null;
  let inputEmitter: { emit: (event: string, input: string) => void } | null = null;
  const settingsService = createMockSettingsService({
    'app.notifications': true,
    'app.notificationsOnApproval': true,
    'app.notificationsOnComplete': true,
    ...(options.settingsOverrides ?? {}),
  });
  const loggingService =
    options.loggingService ?? ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as any);

  const Harness = () => {
    useCaptureInputEmitter((emitter) => {
      inputEmitter = emitter;
    });
    controls = useTerminalFocusNotifier({
      stdout: options.stdout,
      settingsService,
      loggingService,
    });
    return null;
  };

  const view = await renderInAct(<Harness />);

  return {
    controls: () => {
      if (!controls) throw new Error('hook did not initialize');
      return controls;
    },
    inputEmitter: () => {
      if (!inputEmitter) throw new Error('stdin emitter was not captured');
      return inputEmitter;
    },
    unmount: async () => {
      await act(async () => {
        view.unmount();
      });
    },
  };
};

const emitInput = async (emitter: { emit: (event: string, input: string) => void }, input: string) => {
  await act(async () => {
    emitter.emit('input', input);
  });
};

it.sequential('writes focus mode enable and disable sequences on mount and unmount', async () => {
  const writes: string[] = [];
  const { unmount } = await renderHook({
    stdout: {
      write: (value) => {
        writes.push(value);
        return true;
      },
    },
  });

  expect(writes).toEqual(['\x1b[?1004h']);

  await unmount();

  expect(writes).toEqual(['\x1b[?1004h', '\x1b[?1004l']);
});

it.sequential('focus out marks the terminal unfocused and focus in restores it', async () => {
  mocks.sendNotification.mockClear();
  const { controls, inputEmitter } = await renderHook({
    stdout: {
      write: () => true,
    },
  });

  expect(() => controls().approvalNeeded()).not.toThrow();
  expect(mocks.sendNotification).not.toHaveBeenCalled();

  await emitInput(inputEmitter(), '\x1b[O');
  controls().approvalNeeded();
  expect(mocks.sendNotification).toHaveBeenCalledTimes(1);

  mocks.sendNotification.mockClear();
  await emitInput(inputEmitter(), '\x1b[I');
  controls().approvalNeeded();
  expect(mocks.sendNotification).not.toHaveBeenCalled();
});

it.sequential('approvalNeeded only notifies when unfocused and app notifications are enabled', async () => {
  mocks.sendNotification.mockClear();
  const { controls, inputEmitter } = await renderHook({
    stdout: {
      write: () => true,
    },
  });

  controls().approvalNeeded();
  expect(mocks.sendNotification).not.toHaveBeenCalled();

  await emitInput(inputEmitter(), '\x1b[O');
  controls().approvalNeeded();
  expect(mocks.sendNotification).toHaveBeenCalledWith(
    'Approval needed',
    'Agent is waiting for your approval',
    expect.objectContaining({ logger: expect.anything() }),
  );
});

it.sequential('turnComplete only notifies when unfocused and app notifications are enabled', async () => {
  mocks.sendNotification.mockClear();
  const { controls, inputEmitter } = await renderHook({
    stdout: {
      write: () => true,
    },
  });

  controls().turnComplete();
  expect(mocks.sendNotification).not.toHaveBeenCalled();

  await emitInput(inputEmitter(), '\x1b[O');
  controls().turnComplete();
  expect(mocks.sendNotification).toHaveBeenCalledWith(
    'Response ready',
    'Agent has finished responding',
    expect.objectContaining({ logger: expect.anything() }),
  );
});

it.sequential('does not notify when app notifications are disabled', async () => {
  mocks.sendNotification.mockClear();
  const { controls, inputEmitter } = await renderHook({
    stdout: {
      write: () => true,
    },
    settingsOverrides: {
      'app.notifications': false,
    },
  });

  await emitInput(inputEmitter(), '\x1b[O');
  controls().approvalNeeded();
  controls().turnComplete();

  expect(mocks.sendNotification).not.toHaveBeenCalled();
});
