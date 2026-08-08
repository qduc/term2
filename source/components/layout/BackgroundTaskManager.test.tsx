// @ts-expect-error IS_REACT_ACT_ENVIRONMENT is not in globalThis types
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import React, { act } from 'react';
import { expect, it, vi } from 'vitest';
import { renderInAct } from '../../test-helpers/ink-testing.js';
import BackgroundTaskManager from './BackgroundTaskManager.js';

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
};

const writeInput = async (stdin: { write: (value: string) => void }, value: string) => {
  await act(async () => {
    stdin.write(value);
    await new Promise((resolve) => setImmediate(resolve));
  });
};

it.sequential('opens with Ctrl+B and exposes retained tasks without replacing the compact panel', async () => {
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

  await writeInput(view.stdin, '\x02');
  await writeInput(view.stdin, '\u001B[B');
  await writeInput(view.stdin, '\r');

  const output = view.lastFrame() ?? '';
  expect(getDetails).toHaveBeenCalledWith({ kind: 'shell', id: 'shell-1' });
  expect(output).toContain('ID: shell-1');
  expect(output).toContain('Command: pnpm test -- source/services');
  expect(output).toContain('Status: running');
});

it.sequential('requires confirmation before force stopping exactly one live task', async () => {
  const requestStop = vi.fn(() => ({ ok: true as const, details: { ...subagent, status: 'cancelling' as const } }));
  const view = await renderInAct(
    <BackgroundTaskManager listDetails={() => [subagent]} getDetails={() => subagent} requestStop={requestStop} />,
  );

  await writeInput(view.stdin, '\x02');
  await writeInput(view.stdin, 'x');
  expect(view.lastFrame() ?? '').toContain('Press Enter to force stop');
  expect(requestStop).not.toHaveBeenCalled();

  await writeInput(view.stdin, '\r');
  expect(requestStop).toHaveBeenCalledOnce();
  expect(requestStop).toHaveBeenCalledWith({ kind: 'subagent', id: 'run-1' });
  expect(view.lastFrame() ?? '').toContain('Stop requested');
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

  await writeInput(view.stdin, '\x02');
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

  await writeInput(view.stdin, '\x02');
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

  await writeInput(view.stdin, '\x02');
  expect(view.lastFrame() ?? '').toContain('[worker · foreground] inspect the approval boundary');
  await writeInput(view.stdin, 'b');
  await writeInput(view.stdin, '\r');

  expect(moveForegroundToBackground).toHaveBeenCalledWith({ kind: 'subagent', runId: 'child-1' });
  expect(view.lastFrame() ?? '').toContain('Moved to background');
});
