// @ts-expect-error IS_REACT_ACT_ENVIRONMENT is not in globalThis types
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import React from 'react';
import { act } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import { Text } from 'ink';
import { renderInAct, rerenderInAct } from '../test-helpers/ink-testing.js';
import { ShellInteractionSession } from '../services/shell/shell-interaction-session.js';
import { useShellMode } from './use-shell-mode.js';

const mocks = vi.hoisted(() => ({
  executeFormattedShellCommand: vi.fn(),
  addShellMessage: vi.fn(),
  replaceInput: vi.fn(),
  addShellContext: vi.fn(),
}));

vi.mock('../utils/shell/shell-session.js', () => ({
  executeFormattedShellCommand: (...args: unknown[]) => mocks.executeFormattedShellCommand(...args),
  serializeShellHistory: (
    entries: Array<{ command: string; output: string; exitCode: number | null; timedOut: boolean }>,
  ) => entries.map((entry) => `${entry.command}|${entry.output}|${entry.exitCode}|${entry.timedOut}`).join('\n'),
}));

let shellApi: ReturnType<typeof useShellMode> | undefined;

const Harness = (props: Parameters<typeof useShellMode>[0]) => {
  shellApi = useShellMode(props);
  return <Text>shell</Text>;
};

const createSession = (liteMode = true) =>
  new ShellInteractionSession({
    settingsService: { get: vi.fn(() => undefined) } as any,
    conversationSink: { addShellContext: mocks.addShellContext },
    liteMode,
  });

const renderHarness = async (liteMode = true, session = createSession(liteMode)) => {
  return renderInAct(
    <Harness
      session={session}
      addShellMessage={mocks.addShellMessage}
      replaceInput={mocks.replaceInput}
      liteMode={liteMode}
    />,
  );
};

beforeEach(() => {
  mocks.executeFormattedShellCommand.mockReset();
  mocks.executeFormattedShellCommand.mockResolvedValue({ text: 'command output', exitCode: 0, timedOut: false });
  mocks.addShellMessage.mockReset();
  mocks.replaceInput.mockReset();
  mocks.addShellContext.mockReset();
});

it('clears the composer and projects accepted shell command results', async () => {
  const session = createSession();
  await renderHarness(true, session);

  await act(async () => {
    shellApi!.toggleShellMode();
  });

  await act(async () => {
    await shellApi!.handleShellSubmit('  ls  ');
  });

  expect(mocks.replaceInput).toHaveBeenCalledWith('');
  expect(mocks.executeFormattedShellCommand).toHaveBeenCalledWith(expect.objectContaining({ command: 'ls' }));
  expect(mocks.addShellMessage).toHaveBeenCalledWith('ls', 'command output', 0, false);
});

it('flushes shell history when shell mode closes', async () => {
  const session = createSession();
  await renderHarness(true, session);

  await act(async () => {
    shellApi!.toggleShellMode();
  });

  await act(async () => {
    await shellApi!.handleShellSubmit('echo one');
  });

  await act(async () => {
    shellApi!.toggleShellMode();
  });

  expect(mocks.addShellContext).toHaveBeenCalledWith(expect.stringContaining('echo one|command output|0|false'));
});

it('auto-exits shell mode in non-lite mode and flushes pending history', async () => {
  const session = createSession();
  const view = await renderHarness(true, session);

  await act(async () => {
    shellApi!.toggleShellMode();
  });

  await act(async () => {
    await shellApi!.handleShellSubmit('echo two');
  });

  await rerenderInAct(
    view,
    <Harness
      session={session}
      addShellMessage={mocks.addShellMessage}
      replaceInput={mocks.replaceInput}
      liteMode={false}
    />,
  );

  expect(mocks.addShellContext).toHaveBeenCalledWith(expect.stringContaining('echo two|command output|0|false'));
});
