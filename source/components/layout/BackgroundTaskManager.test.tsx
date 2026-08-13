// @ts-expect-error IS_REACT_ACT_ENVIRONMENT is not in globalThis types
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import React, { act, useState } from 'react';
import { expect, it, vi } from 'vitest';
import { renderInAct, rerenderInAct, toVisibleText } from '../../test-helpers/ink-testing.js';
import BackgroundTaskManagerView, { type BackgroundTaskManagerProps } from './BackgroundTaskManager.js';

type TestManagerProps = Omit<BackgroundTaskManagerProps, 'open' | 'onOpenChange'> & {
  onOpenChange?: (open: boolean) => void;
};

const BackgroundTaskManager = ({ onOpenChange, ...props }: TestManagerProps) => {
  const [open, setOpen] = useState(false);
  return (
    <BackgroundTaskManagerView
      {...props}
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        onOpenChange?.(next);
      }}
    />
  );
};

const subagent = {
  kind: 'subagent' as const,
  id: 'run-1',
  name: 'repo_scan',
  role: 'explorer',
  task: 'inspect every lifecycle boundary\nand summarize the risks',
  taskPreview: 'inspect every lifecycle boundary',
  status: 'running' as const,
  startedAt: 1_000,
  elapsedMs: 4_000,
  toolCounts: { shell: 2, read_file: 3 },
  currentText: 'Checking the shell ownership path.',
};

const shell = {
  kind: 'shell' as const,
  id: 'shell-1',
  command: 'pnpm test -- source/services',
  status: 'running' as const,
  startedAt: 2_000,
};

const foregroundShell = {
  kind: 'shell' as const,
  callId: 'call-1',
  jobId: 'shell-2',
  command: 'pnpm test:provider-black-box',
  status: 'running' as const,
  startedAt: 3_000,
};

const foregroundSubagent = {
  kind: 'subagent' as const,
  runId: 'child-1',
  role: 'worker',
  task: 'inspect the approval boundary',
  parentTool: 'run_subagent',
  status: 'running' as const,
  startedAt: 4_000,
};

const writeInput = async (stdin: { write: (value: string) => void }, value: string) => {
  await act(async () => {
    stdin.write(value);
    await new Promise((resolve) => setImmediate(resolve));
  });
};

it.sequential('opens with Ctrl+G and exposes retained tasks without replacing the compact panel', async () => {
  const onOpenChange = vi.fn();
  const view = await renderInAct(
    <BackgroundTaskManager
      listDetails={() => [subagent, shell]}
      getDetails={() => subagent}
      requestStop={() => ({ ok: false as const, code: 'not_active' as const })}
      onOpenChange={onOpenChange}
    />,
  );

  expect(view.lastFrame() ?? '').toBe('');
  await writeInput(view.stdin, '\x02');
  expect(view.lastFrame() ?? '').toBe('');
  await writeInput(view.stdin, '\x07');

  const output = view.lastFrame() ?? '';
  expect(output).toContain('Manage background tasks');
  expect(output).toContain('repo_scan');
  expect(output).toContain('pnpm test -- source/services');
  expect(output).toContain('Enter details');
  expect(onOpenChange).toHaveBeenCalledWith(true);
});

it.sequential('selects a task and shows executor-specific details on Enter', async () => {
  const getDetails = vi.fn((target: { kind: 'subagent' | 'shell'; id: string }) =>
    target.kind === 'shell' ? shell : subagent,
  );
  const view = await renderInAct(
    <BackgroundTaskManager
      listDetails={() => [subagent, shell]}
      getDetails={getDetails}
      requestStop={() => ({ ok: false as const, code: 'not_active' as const })}
    />,
  );

  await writeInput(view.stdin, '\x07');
  await writeInput(view.stdin, '\u001B[B');
  await writeInput(view.stdin, '\r');

  const output = view.lastFrame() ?? '';
  expect(getDetails).toHaveBeenCalledWith({ kind: 'shell', id: 'shell-1' });
  expect(output).toContain('ID: shell-1');
  expect(output).toContain('Command: pnpm test -- source/services');
  expect(output).toContain('State: running');
});

it.sequential('requires confirmation before force stopping exactly one live task', async () => {
  const requestStop = vi.fn(() => ({ ok: true as const, details: { ...subagent, status: 'cancelling' as const } }));
  const view = await renderInAct(
    <BackgroundTaskManager listDetails={() => [subagent]} getDetails={() => subagent} requestStop={requestStop} />,
  );

  await writeInput(view.stdin, '\x07');
  await writeInput(view.stdin, 'x');
  expect(view.lastFrame() ?? '').toContain('Press Enter to force stop');
  expect(requestStop).not.toHaveBeenCalled();

  await writeInput(view.stdin, '\r');
  expect(requestStop).toHaveBeenCalledOnce();
  expect(requestStop).toHaveBeenCalledWith({ kind: 'subagent', id: 'run-1' });
  expect(view.lastFrame() ?? '').toContain('Stop requested');
});

it.sequential('reconciles refreshed task order by identity before rendering and handling stop keys', async () => {
  const first = { ...subagent, id: 'first', name: 'first_task' };
  const second = { ...subagent, id: 'second', name: 'second_task' };
  const inserted = { ...subagent, id: 'inserted', name: 'inserted_task' };
  let current = [first, second];
  const requestStop = vi.fn((target: { kind: 'subagent' | 'shell'; id: string }) => ({
    ok: true as const,
    details: { ...(target.id === 'second' ? second : first), id: target.id, status: 'cancelling' as const },
  }));
  const props = {
    listDetails: () => current,
    getDetails: () => null,
    requestStop,
  };
  const view = await renderInAct(<BackgroundTaskManager {...props} />);
  await writeInput(view.stdin, '\x07');
  await writeInput(view.stdin, '\u001B[B');

  current = [second, inserted, first];
  await rerenderInAct(view, <BackgroundTaskManager {...props} />);
  expect((view.lastFrame() ?? '').split('\n').find((line) => line.includes('❯'))).toContain('second_task');
  await writeInput(view.stdin, 'x');
  await writeInput(view.stdin, '\r');
  expect(requestStop).toHaveBeenLastCalledWith({ kind: 'subagent', id: 'second' });

  current = [inserted, first];
  await rerenderInAct(view, <BackgroundTaskManager {...props} />);
  expect((view.lastFrame() ?? '').split('\n').find((line) => line.includes('❯'))).toContain('first_task');
  await writeInput(view.stdin, 'x');
  await writeInput(view.stdin, '\r');
  expect(requestStop).toHaveBeenLastCalledWith({ kind: 'subagent', id: 'first' });
});

it.sequential('transfers the highlighted foreground identity after refreshed candidates reorder', async () => {
  const first = { ...foregroundSubagent, runId: 'first-child', task: 'first child task' };
  const second = { ...foregroundSubagent, runId: 'second-child', task: 'second child task' };
  const inserted = { ...foregroundSubagent, runId: 'inserted-child', task: 'inserted child task' };
  let current = [first, second];
  const moveForegroundToBackground = vi.fn(
    (target: Parameters<NonNullable<BackgroundTaskManagerProps['moveForegroundToBackground']>>[0]) => {
      const movedId = target.kind === 'subagent' ? target.runId : target.callId;
      return {
        ok: true as const,
        details: { ...subagent, id: movedId, task: `${movedId} moved` },
      };
    },
  );
  const props = {
    listDetails: () => [],
    getDetails: () => null,
    requestStop: () => ({ ok: false as const, code: 'not_active' as const }),
    listForegroundTransferCandidates: () => current,
    moveForegroundToBackground,
  };
  const view = await renderInAct(<BackgroundTaskManager {...props} />);
  await writeInput(view.stdin, '\x07');
  await writeInput(view.stdin, '\u001B[B');

  current = [second, inserted, first];
  await rerenderInAct(view, <BackgroundTaskManager {...props} />);
  expect((view.lastFrame() ?? '').split('\n').find((line) => line.includes('❯'))).toContain('second child task');
  await writeInput(view.stdin, 'b');
  await writeInput(view.stdin, '\r');

  expect(moveForegroundToBackground).toHaveBeenCalledWith({ kind: 'subagent', runId: 'second-child' });
});

it.sequential('keeps quiet work visibly running and stoppable without calling it hung', async () => {
  const quiet = {
    ...subagent,
    activity: {
      phase: 'waiting' as const,
      reason: 'provider' as const,
      lastObservation: { kind: 'request_dispatched' as const, at: 1_000 },
      liveness: { state: 'quiet' as const, lastObservedAt: 1_000, ageMs: 30_000 },
    },
  };
  const requestStop = vi.fn(() => ({ ok: true as const, details: { ...quiet, status: 'cancelling' as const } }));
  const view = await renderInAct(
    <BackgroundTaskManager listDetails={() => [quiet]} getDetails={() => quiet} requestStop={requestStop} />,
  );

  await writeInput(view.stdin, '\x07');
  expect(view.lastFrame() ?? '').toContain('quiet');
  expect(view.lastFrame() ?? '').toContain('[x] Force stop');
  expect(view.lastFrame() ?? '').not.toContain('hung');
  await writeInput(view.stdin, 'x');
  await writeInput(view.stdin, '\r');
  expect(requestStop).toHaveBeenCalledWith({ kind: 'subagent', id: 'run-1' });
});

it.sequential('renders diagnostic model, context, retry, and observation fields only when known', async () => {
  const detailed = {
    ...subagent,
    model: { provider: 'openai', id: 'gpt-4o', contextWindow: 128_000 },
    latestUsage: { prompt_tokens: 12_300 },
    lastToolName: 'read_file',
    activity: {
      phase: 'waiting' as const,
      reason: 'provider' as const,
      lastObservation: { kind: 'retrying' as const, at: 1_000, attempt: 1, maxRetries: 3 },
      liveness: { state: 'recent' as const, lastObservedAt: 1_000, ageMs: 18_000 },
    },
  };
  const view = await renderInAct(
    <BackgroundTaskManager
      listDetails={() => [detailed]}
      getDetails={() => detailed}
      requestStop={() => ({ ok: false as const, code: 'not_active' as const })}
    />,
  );
  await writeInput(view.stdin, '\x07');
  await writeInput(view.stdin, '\r');
  const output = view.lastFrame() ?? '';
  expect(output).toContain('Last observed: 18s ago');
  expect(output).toContain('Last activity: Retrying 1 of 3');
  expect(output).toContain('Model: gpt-4o');
  expect(output).toContain('Provider: openai');
  expect(output).toContain('Context: 12.3k / 128k (9.6%)');
  expect(output).toContain('Retries: 1 of 3');
  expect(output).toContain('Last tool: read_file');
});

it.sequential('bounds and sanitizes every toolCounts key in the rendered Tools row', async () => {
  const unsafeName = `shell\nline\u001b]8;;https://example.invalid\u0007link\u001b]8;;\u0007${'x'.repeat(160)}`;
  const manyCounts = Object.fromEntries([
    ['unicode_工具', 2],
    [unsafeName, 7],
    ...Array.from({ length: 18 }, (_, index) => [`unicode_工具_${index}_${'y'.repeat(32)}`, index + 1] as const),
  ]);
  const detailed = { ...subagent, toolCounts: manyCounts };
  const view = await renderInAct(
    <BackgroundTaskManager
      listDetails={() => [detailed]}
      getDetails={() => detailed}
      requestStop={() => ({ ok: false as const, code: 'not_active' as const })}
    />,
  );

  await writeInput(view.stdin, '\x07');
  await writeInput(view.stdin, '\r');
  const raw = view.lastFrame() ?? '';
  const toolsLine =
    toVisibleText(raw)
      .split('\n')
      .find((line) => line.includes('Tools:')) ?? '';
  const toolsContent = toolsLine
    .slice(toolsLine.indexOf('Tools:') + 'Tools:'.length)
    .replace(/\s*│$/, '')
    .trim();
  expect(raw).not.toContain('\u001b]8;;');
  expect(raw).not.toContain('\u0007');
  expect(toolsLine).not.toContain('shell\nline');
  expect(toolsLine).toContain('shell line');
  expect(toolsLine).toContain('×7');
  expect(toolsLine).toContain('工具');
  expect(toolsContent).toMatch(/… \+\d+ more$/);
  expect(toolsContent.length).toBeLessThanOrEqual(80);
});

it.sequential('shows provider and approval waits separately from quiet and terminal failure', async () => {
  const waiting = {
    ...subagent,
    activity: {
      phase: 'waiting' as const,
      reason: 'provider' as const,
      lastObservation: { kind: 'request_dispatched' as const, at: 1_000 },
      liveness: { state: 'recent' as const, lastObservedAt: 1_000, ageMs: 1_000 },
    },
  };
  const approval = {
    ...subagent,
    id: 'approval',
    status: 'awaiting_approval' as const,
    activity: {
      phase: 'waiting' as const,
      reason: 'approval' as const,
      lastObservation: { kind: 'approval_requested' as const, at: 1_000 },
      liveness: { state: 'recent' as const, lastObservedAt: 1_000, ageMs: 1_000 },
    },
  };
  const failed = { ...subagent, id: 'failed', status: 'failed' as const, error: 'exit 1' };
  const view = await renderInAct(
    <BackgroundTaskManager
      listDetails={() => [waiting, approval, failed]}
      getDetails={() => waiting}
      requestStop={() => ({ ok: false as const, code: 'not_active' as const })}
    />,
  );

  await writeInput(view.stdin, '\x07');
  expect(view.lastFrame() ?? '').toContain('awaiting provider');
  await writeInput(view.stdin, '\u001B[B');
  expect(view.lastFrame() ?? '').toContain('awaiting approval');
  await writeInput(view.stdin, '\u001B[B');
  expect(view.lastFrame() ?? '').toContain('failed · terminal');
});

it.sequential('does not offer force stop for settled work and Escape restores the previous input owner', async () => {
  const onOpenChange = vi.fn();
  const completed = { ...shell, status: 'completed' as const, completedAt: 4_000 };
  const view = await renderInAct(
    <BackgroundTaskManager
      listDetails={() => [completed]}
      getDetails={() => completed}
      requestStop={() => ({ ok: false as const, code: 'not_active' as const })}
      onOpenChange={onOpenChange}
    />,
  );

  await writeInput(view.stdin, '\x07');
  expect(view.lastFrame() ?? '').not.toContain('[x] Force stop');
  await writeInput(view.stdin, '\u001B');
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  expect(view.lastFrame() ?? '').toBe('');
  expect(onOpenChange).toHaveBeenLastCalledWith(false);
});

it.sequential('opens for a foreground shell and requires confirmation before moving the same execution', async () => {
  const moveForegroundToBackground = vi.fn(() => ({
    ok: true as const,
    details: { ...shell, id: foregroundShell.jobId },
  }));
  const view = await renderInAct(
    <BackgroundTaskManager
      listDetails={() => []}
      getDetails={() => null}
      requestStop={() => ({ ok: false as const, code: 'not_active' as const })}
      getForegroundTransferCandidate={() => foregroundShell}
      moveForegroundToBackground={moveForegroundToBackground}
    />,
  );

  await writeInput(view.stdin, '\x07');
  expect(view.lastFrame() ?? '').toContain('pnpm test:provider-black-box');
  expect(view.lastFrame() ?? '').toContain('[b] Put in background');

  await writeInput(view.stdin, 'b');
  expect(view.lastFrame() ?? '').toContain('Press Enter to put this shell in the background');
  expect(moveForegroundToBackground).not.toHaveBeenCalled();

  await writeInput(view.stdin, '\r');
  expect(moveForegroundToBackground).toHaveBeenCalledWith({ kind: 'shell', callId: 'call-1' });
  expect(view.lastFrame() ?? '').toContain('Moved to background');
});

it.sequential('lists and transfers a foreground subagent through the same manager', async () => {
  const moveForegroundToBackground = vi.fn(() => ({
    ok: true as const,
    details: { ...subagent, id: 'child-1', task: foregroundSubagent.task },
  }));
  const view = await renderInAct(
    <BackgroundTaskManager
      listDetails={() => []}
      getDetails={() => null}
      requestStop={() => ({ ok: false as const, code: 'not_active' as const })}
      listForegroundTransferCandidates={() => [foregroundSubagent]}
      moveForegroundToBackground={moveForegroundToBackground}
    />,
  );

  await writeInput(view.stdin, '\x07');
  expect(view.lastFrame() ?? '').toContain('[worker · foreground] inspect the approval boundary');
  await writeInput(view.stdin, 'b');
  expect(view.lastFrame() ?? '').toContain('Press Enter to put this subagent in the background');
  await writeInput(view.stdin, '\r');

  expect(moveForegroundToBackground).toHaveBeenCalledWith({ kind: 'subagent', runId: 'child-1' });
  expect(view.lastFrame() ?? '').toContain('Moved to background');
});
