// @ts-expect-error IS_REACT_ACT_ENVIRONMENT is not in globalThis types
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import { expect, it } from 'vitest';
import React from 'react';
import { renderInAct, rerenderInAct } from '../../test-helpers/ink-testing.js';
import type { BackgroundSubagentTask, BackgroundTask } from '../../services/subagents/subagent-notification-store.js';
import BackgroundTasksPanel from './BackgroundTasksPanel.js';

const runningTask = (overrides: Partial<BackgroundSubagentTask> = {}): BackgroundSubagentTask => ({
  kind: 'subagent',
  runId: 'run-1',
  role: 'explorer',
  task: 'inspect the project for the rendering regression',
  status: 'running',
  startedAt: 1_000,
  ...overrides,
});

it.sequential('is absent when there are no active or recently completed background tasks', async () => {
  const renderer = await renderInAct(<BackgroundTasksPanel tasks={[]} now={1_000} />);

  expect(renderer.lastFrame() ?? '').toBe('');
});

it.sequential('renders a shell job without assigning it a subagent role', async () => {
  const task: BackgroundTask = {
    kind: 'shell',
    jobId: 'shell-1',
    command: 'pnpm test -- source/components',
    status: 'running',
    startedAt: 1_000,
  };
  const renderer = await renderInAct(<BackgroundTasksPanel tasks={[task]} now={4_000} />);

  const output = renderer.lastFrame() ?? '';
  expect(output).toContain('Background tasks · 1 active');
  expect(output).toContain('[Shell]');
  expect(output).toContain('pnpm test -- source/components');
  expect(output).toContain('Running · 3s');
  expect(output).not.toContain('Explorer');
});

it.sequential('shows active count, short task label, role badge, status, and elapsed duration', async () => {
  const renderer = await renderInAct(
    <BackgroundTasksPanel
      tasks={[
        runningTask({ name: 'ui_fix', role: 'worker', task: 'implement the narrow background lifecycle panel' }),
        runningTask({
          runId: 'run-2',
          role: 'explorer',
          task: 'verify the event contract',
          startedAt: 61_000,
        }),
      ]}
      now={66_000}
    />,
  );

  const output = renderer.lastFrame() ?? '';
  expect(output).toContain('Background tasks · 2 active');
  expect(output).toContain('Worker');
  expect(output).toContain('ui_fix');
  expect(output).toContain('Explorer');
  expect(output).toContain('implement the narrow background lifecycle panel');
  expect(output).toContain('Running · 1m 05s');
  expect(output).toContain('Running · 5s');
  expect(output).not.toContain('model');
});

it.sequential('shows completed context usage at the right side of a named task', async () => {
  const renderer = await renderInAct(
    <BackgroundTasksPanel
      tasks={[
        runningTask({
          name: 'code_scan',
          status: 'completed',
          completedAt: 2_000,
          usage: { prompt_tokens: 12_345 },
        }),
      ]}
      now={2_000}
    />,
  );

  const output = renderer.lastFrame() ?? '';
  expect(output).toContain('code_scan');
  expect(output).toContain('Ctx 12.3k');
});

it.sequential('updates elapsed duration when time advances', async () => {
  const task = runningTask();
  const renderer = await renderInAct(<BackgroundTasksPanel tasks={[task]} now={1_000} />);
  expect(renderer.lastFrame() ?? '').toContain('Running · 0s');

  await rerenderInAct(renderer, <BackgroundTasksPanel tasks={[task]} now={4_000} />);
  expect(renderer.lastFrame() ?? '').toContain('Running · 3s');
});

it.sequential('keeps long task labels compact', async () => {
  const longTask = 'inspect every rendering and lifecycle boundary '.repeat(4);
  const renderer = await renderInAct(<BackgroundTasksPanel tasks={[runningTask({ task: longTask })]} now={1_000} />);

  const output = renderer.lastFrame() ?? '';
  expect(output).toContain('…');
  expect(output).not.toContain(longTask.trim());
});

it.sequential('nests the most recent tool call under its running task', async () => {
  const renderer = await renderInAct(
    <BackgroundTasksPanel
      tasks={[runningTask({ lastTool: { label: 'grep "TODO" src/', state: 'running' } })]}
      now={1_000}
    />,
  );

  const lines = (renderer.lastFrame() ?? '').split('\n');
  const taskLine = lines.findIndex((line) => line.includes('Explorer'));
  const toolLine = lines[taskLine + 1] ?? '';

  expect(toolLine).toContain('└');
  expect(toolLine).toContain('▶');
  expect(toolLine).toContain('grep "TODO" src/');
  expect(toolLine.indexOf('└')).toBeGreaterThan(lines[taskLine]!.indexOf('•'));
});

it.sequential('marks a settled tool call with its outcome', async () => {
  const renderer = await renderInAct(
    <BackgroundTasksPanel tasks={[runningTask({ lastTool: { label: 'pnpm test', state: 'success' } })]} now={1_000} />,
  );
  expect(renderer.lastFrame() ?? '').toContain('✔ pnpm test');

  await rerenderInAct(
    renderer,
    <BackgroundTasksPanel tasks={[runningTask({ lastTool: { label: 'pnpm test', state: 'failed' } })]} now={1_000} />,
  );
  expect(renderer.lastFrame() ?? '').toContain('✖ pnpm test');
});

it.sequential('keeps long tool labels compact', async () => {
  const longLabel = `grep "${'pattern-fragment '.repeat(10)}" source/`;
  const renderer = await renderInAct(
    <BackgroundTasksPanel tasks={[runningTask({ lastTool: { label: longLabel, state: 'running' } })]} now={1_000} />,
  );

  const output = renderer.lastFrame() ?? '';
  expect(output).toContain('…');
  expect(output).not.toContain(longLabel);
});

it.sequential('omits the tool line for a task with no observed tool activity', async () => {
  const renderer = await renderInAct(<BackgroundTasksPanel tasks={[runningTask()]} now={1_000} />);

  expect(renderer.lastFrame() ?? '').not.toContain('└');
});

it.sequential('shows a concise recently completed indication without counting it as active', async () => {
  const renderer = await renderInAct(
    <BackgroundTasksPanel
      tasks={[
        runningTask({
          status: 'completed',
          completedAt: 6_000,
          lastTool: { label: 'pnpm test', state: 'success' },
        }),
      ]}
      now={7_000}
    />,
  );

  const output = renderer.lastFrame() ?? '';
  expect(output).toContain('Background tasks · 0 active');
  expect(output).toContain('Explorer');
  expect(output).toContain('Completed recently');
  expect(output).not.toContain('Running');
  // A settled task's tool history is stale; the completion status carries it.
  expect(output).not.toContain('pnpm test');
});

it.sequential('shows failure reason for recently failed tasks when error is present', async () => {
  const renderer = await renderInAct(
    <BackgroundTasksPanel
      tasks={[
        runningTask({
          task: 'inspect',
          status: 'failed',
          completedAt: 6_000,
          error: 'Max turns (100) exceeded',
        }),
      ]}
      now={7_000}
    />,
  );

  const output = renderer.lastFrame() ?? '';
  expect(output).toContain('Failed recently (Max turns (100) exceeded)');
});

it.sequential(
  'distinguishes observed activity, provider waits, quiet work, and confirmed terminal failure',
  async () => {
    const renderer = await renderInAct(
      <BackgroundTasksPanel
        tasks={
          [
            {
              kind: 'subagent',
              id: 'active',
              role: 'explorer',
              task: 'observe activity',
              taskPreview: 'observe activity',
              status: 'running',
              startedAt: 1_000,
              elapsedMs: 2_000,
              toolCounts: {},
              activity: { state: 'active', lastActivityAt: 2_000 },
            },
            {
              kind: 'subagent',
              id: 'waiting',
              role: 'explorer',
              task: 'wait for provider',
              taskPreview: 'wait for provider',
              status: 'running',
              startedAt: 1_000,
              elapsedMs: 3_000,
              toolCounts: {},
              activity: { state: 'waiting', reason: 'provider', lastActivityAt: 3_000 },
            },
            {
              kind: 'shell',
              id: 'quiet-shell',
              command: 'tail -f log',
              status: 'running',
              startedAt: 1_000,
              activity: { state: 'quiet', lastActivityAt: 1_000 },
            },
            {
              kind: 'subagent',
              id: 'failed',
              role: 'worker',
              task: 'fail',
              taskPreview: 'fail',
              status: 'failed',
              startedAt: 1_000,
              elapsedMs: 4_000,
              toolCounts: {},
              activity: { state: 'settled', lastActivityAt: 4_000 },
              error: 'exit 1',
            },
          ] as any
        }
        now={4_000}
      />,
    );

    const output = renderer.lastFrame() ?? '';
    expect(output).toContain('Active');
    expect(output).toContain('Waiting for provider');
    expect(output).toContain('last activity 2s ago');
    expect(output).toContain('Quiet · no observed progress');
    expect(output).toContain('Failed · terminal');
    expect(output).not.toContain('hung');
  },
);

it.sequential('drops each settled row once its linger expires, leaving still-running rows', async () => {
  const finished = runningTask({ runId: 'run-done', task: 'finished work', status: 'completed' });
  const running = runningTask({ runId: 'run-live', task: 'ongoing work' });
  const renderer = await renderInAct(<BackgroundTasksPanel tasks={[finished, running]} now={10_000} />);

  expect(renderer.lastFrame() ?? '').toContain('finished work');
  expect(renderer.lastFrame() ?? '').toContain('Background tasks · 1 active');

  await rerenderInAct(renderer, <BackgroundTasksPanel tasks={[finished, running]} now={16_000} />);

  const output = renderer.lastFrame() ?? '';
  expect(output).not.toContain('finished work');
  expect(output).toContain('ongoing work');
  expect(output).toContain('Background tasks · 1 active');
});

it.sequential('hides the whole panel once every row has settled and lingered', async () => {
  const finished = runningTask({ runId: 'run-done', status: 'completed' });
  const renderer = await renderInAct(<BackgroundTasksPanel tasks={[finished]} now={10_000} />);

  expect(renderer.lastFrame() ?? '').toContain('Background tasks · 0 active');

  await rerenderInAct(renderer, <BackgroundTasksPanel tasks={[finished]} now={16_000} />);

  expect(renderer.lastFrame() ?? '').toBe('');
});
