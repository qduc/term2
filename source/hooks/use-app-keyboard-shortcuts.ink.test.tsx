// @ts-expect-error IS_REACT_ACT_ENVIRONMENT is not in globalThis types
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import React, { act } from 'react';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { render, Text } from 'ink';
import { expect, it } from 'vitest';
import { getInkRenderOptions } from '../utils/ink-render-options.js';
import { useAppKeyboardShortcuts } from './use-app-keyboard-shortcuts.js';
import type { InputOwner } from '../lib/input-owner.js';

class FakeStdin extends EventEmitter {
  isTTY = true;
  private readonly chunks: string[] = [];

  setRawMode(): void {}
  setEncoding(): void {}
  ref(): void {}
  unref(): void {}
  resume(): void {}
  pause(): void {}

  read(): string | null {
    return this.chunks.shift() ?? null;
  }

  writeInput(input: string): void {
    this.chunks.push(input);
    this.emit('readable');
  }
}

const flushInput = async (stdin: FakeStdin, input: string): Promise<void> => {
  await act(async () => {
    stdin.writeInput(input);
    await new Promise((resolve) => setImmediate(resolve));
  });
};

it.sequential('real Ink input leaves the first Ctrl+C to the app and exits on the second', async () => {
  const stdin = new FakeStdin();
  const stdout = new PassThrough() as PassThrough & { columns: number; rows: number; isTTY: boolean };
  stdout.columns = 80;
  stdout.rows = 24;
  stdout.isTTY = true;
  stdout.on('data', () => {});

  let exitCount = 0;
  const Harness = () => {
    useAppKeyboardShortcuts({
      exitWithUsage: () => {
        exitCount += 1;
      },
      pendingSkillRef: { current: null },
      waitingForAskUserAnswer: false,
      setWaitingForAskUserAnswer: () => {},
      waitingForRejectionReason: false,
      setWaitingForRejectionReason: () => {},
      inputMode: 'text',
      inputValue: '',
      isProcessing: false,
      waitingForApproval: false,
      stopProcessing: () => {},
      handoffState: null,
      cancelHandoff: () => {},
      pendingLargeUncachedTurn: null,
      cycleAppModes: () => {},
      replaceInput: () => {},
      onSkillActivationCancelled: () => {},
      approvalShortcutsEnabled: false,
      onApprove: () => {},
      onReject: () => {},
      submitRejectionReason: () => {},
      inputOwner: { kind: 'input' } as InputOwner,
    });
    return <Text>ready</Text>;
  };

  let instance!: ReturnType<typeof render>;
  await act(async () => {
    instance = render(<Harness />, {
      ...getInkRenderOptions(),
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      stderr: stdout as unknown as NodeJS.WriteStream,
      interactive: true,
      patchConsole: false,
    });
    await new Promise((resolve) => setImmediate(resolve));
  });

  try {
    await flushInput(stdin, '\x03');
    expect(exitCount).toBe(0);

    await flushInput(stdin, '\x03');
    expect(exitCount).toBe(1);
  } finally {
    await act(async () => {
      instance.unmount();
      instance.cleanup();
    });
  }
});
