// @ts-expect-error IS_REACT_ACT_ENVIRONMENT is not in globalThis types
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import React, { act, useState, useSyncExternalStore } from 'react';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { render, Text } from 'ink';
import { expect, it } from 'vitest';
import { getInkRenderOptions } from '../utils/ink-render-options.js';
import { useAppKeyboardShortcuts } from './use-app-keyboard-shortcuts.js';
import type { InputOwner } from '../lib/input-owner.js';
import { BackgroundSubagentApprovalQueue } from '../services/approval/background-subagent-approval-queue.js';
import { renderInAct } from '../test-helpers/ink-testing.js';

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
      approvalShortcutIdentity: null,
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

it.sequential.each(['y', 'n'])(
  'real Ink input can decide a consecutive background approval with %s',
  async (answer) => {
    const queue = new BackgroundSubagentApprovalQueue();
    const decisions: { runId: string; answer: string; rejectionReason?: string }[] = [];
    for (const runId of ['first', 'second']) {
      queue.enqueue(
        { runId, generation: 1, toolCallId: runId, toolName: 'shell', argumentsText: '{"command":"pwd"}' },
        {
          onResolve: (entry, decision) => {
            decisions.push({ runId: entry.runId, ...decision });
            return { kind: 'applied' };
          },
        },
      );
    }

    const Harness = () => {
      const snapshot = useSyncExternalStore(
        (listener) => queue.subscribe(listener),
        () => queue.getSnapshot(),
      );
      const [waitingForRejectionReason, setWaitingForRejectionReason] = useState(false);
      useAppKeyboardShortcuts({
        exitWithUsage: () => {},
        pendingSkillRef: { current: null },
        waitingForAskUserAnswer: false,
        setWaitingForAskUserAnswer: () => {},
        waitingForRejectionReason,
        setWaitingForRejectionReason,
        inputMode: 'text',
        inputValue: '',
        isProcessing: false,
        waitingForApproval: snapshot.current !== null,
        stopProcessing: () => {},
        handoffState: null,
        cancelHandoff: () => {},
        pendingLargeUncachedTurn: null,
        cycleAppModes: () => {},
        replaceInput: () => {},
        onSkillActivationCancelled: () => {},
        approvalShortcutsEnabled: true,
        approvalShortcutIdentity: snapshot.current?.runId ?? null,
        onApprove: () => {
          if (snapshot.current) {
            queue.resolve({ revision: snapshot.revision, entry: snapshot.current, decision: { answer: 'yes' } });
          }
        },
        onReject: () => setWaitingForRejectionReason(true),
        submitRejectionReason: (rejectionReason) => {
          if (snapshot.current) {
            queue.resolve({
              revision: snapshot.revision,
              entry: snapshot.current,
              decision: { answer: 'no', rejectionReason },
            });
          }
          setWaitingForRejectionReason(false);
        },
        inputOwner: { kind: snapshot.current && !waitingForRejectionReason ? 'approval' : 'input' },
      });
      return <Text>{snapshot.current?.runId ?? 'complete'}</Text>;
    };
    const view = await renderInAct(<Harness />);
    const type = async (input: string) => {
      await act(async () => {
        view.stdin.write(input);
        await new Promise((resolve) => setImmediate(resolve));
      });
    };
    expect(view.lastFrame()).toBe('first');
    await type('y');
    expect(decisions).toEqual([{ runId: 'first', answer: 'yes' }]);
    expect(view.lastFrame()).toBe('second');

    await type(answer);
    if (answer === 'n') {
      await type('needs review');
      await type('\r');
    }
    expect(decisions).toEqual([
      { runId: 'first', answer: 'yes' },
      answer === 'y'
        ? { runId: 'second', answer: 'yes' }
        : { runId: 'second', answer: 'no', rejectionReason: 'needs review' },
    ]);
    expect(queue.getSnapshot().current).toBeNull();
    expect(view.lastFrame()).toBe('complete');
  },
);
