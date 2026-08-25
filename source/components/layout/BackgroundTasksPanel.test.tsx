// @ts-expect-error IS_REACT_ACT_ENVIRONMENT is not in globalThis types
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import { expect, it } from 'vitest';
import React from 'react';
import { renderToString } from 'ink';
import { renderInAct, rerenderInAct } from '../../test-helpers/ink-testing.js';
import type { BackgroundSubagentTask, BackgroundTask } from '../../services/subagents/subagent-notification-store.js';
import BackgroundTasksPanel from './BackgroundTasksPanel.js';
import { mergeLiveTaskRows } from './live-task-rows.js';

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
  expect(output).toContain('Tasks · 1 active');
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
  expect(output).toContain('Tasks · 2 active');
  expect(output).toContain('Worker');
  expect(output).toContain('ui_fix');
  expect(output).toContain('Explorer');
  expect(output).toContain('ui_fix implement the narrow backgr…');
  expect(output).toContain('Running · 1m 05s');
  expect(output).toContain('Running · 5s');
  expect(output).not.toContain('model');
});

it.sequential('keeps normal context telemetry out of the compact medium-width row', async () => {
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
  expect(output).not.toContain('Ctx 12.3k');
});

it.sequential('uses explicit wide, medium, and narrow information budgets without losing task identity', async () => {
  const task = {
    kind: 'subagent' as const,
    id: 'liveness',
    role: 'explorer',
    task: 'audit provider fixtures for stalled request boundaries',
    taskPreview: 'audit provider fixtures for stalled request boundaries',
    status: 'running' as const,
    startedAt: 1_000,
    elapsedMs: 10_000,
    toolCounts: {},
    model: { provider: 'openai', id: 'gpt-4o', contextWindow: 128_000 },
    latestUsage: { prompt_tokens: 120_000 },
    activity: {
      phase: 'waiting' as const,
      reason: 'provider' as const,
      lastObservation: { kind: 'request_dispatched' as const, at: 1_000 },
      liveness: { state: 'quiet' as const, lastObservedAt: 1_000, ageMs: 10_000 },
    },
  };
  {
    const renderer = await renderInAct(<BackgroundTasksPanel tasks={[task]} now={11_000} columns={120} />);
    expect(renderer.lastFrame() ?? '').toContain('no activity observed for 10s');
    expect(renderer.lastFrame() ?? '').toContain('Ctx 120k / 128k (93.8%)');
    await rerenderInAct(renderer, <BackgroundTasksPanel tasks={[task]} now={11_000} columns={72} />);
    expect(renderer.lastFrame() ?? '').toContain('audit provider fixtures for stalle…');
    expect(renderer.lastFrame() ?? '').toContain(' · Waiting');
    expect(renderer.lastFrame() ?? '').toContain('Request handed to model runtime');
    expect(renderer.lastFrame() ?? '').not.toContain('Awaiting provider response');
    expect(renderer.lastFrame() ?? '').not.toContain('Ctx 120k');
    await rerenderInAct(renderer, <BackgroundTasksPanel tasks={[task]} now={11_000} columns={71} />);
    expect(renderer.lastFrame() ?? '').toContain('audit provider fixture…');
    expect(renderer.lastFrame() ?? '').toContain('Waiting');
    await rerenderInAct(renderer, <BackgroundTasksPanel tasks={[task]} now={11_000} columns={40} />);
    expect(renderer.lastFrame() ?? '').toContain('audit provider …');
    expect(renderer.lastFrame() ?? '').not.toContain('Request handed to model runtime');
  }
});

it.sequential(
  'shows tool-call count and model on wide rows, and colors a stalled task apart from a fresh one',
  async () => {
    const stalled = {
      kind: 'subagent' as const,
      id: 'stalled-worker',
      role: 'explorer',
      task: 'audit provider fixtures for stalled request boundaries',
      taskPreview: 'audit provider fixtures for stalled request boundaries',
      status: 'running' as const,
      startedAt: 1_000,
      elapsedMs: 10_000,
      toolCounts: { grep: 3, read_file: 4 },
      model: { provider: 'openai', id: 'gpt-4o', contextWindow: 128_000 },
      activity: {
        phase: 'waiting' as const,
        reason: 'provider' as const,
        lastObservation: { kind: 'request_dispatched' as const, at: 1_000 },
        liveness: { state: 'quiet' as const, lastObservedAt: 1_000, ageMs: 10_000 },
      },
    };
    const fresh = {
      ...stalled,
      id: 'fresh-worker',
      toolCounts: { grep: 1 },
      activity: {
        ...stalled.activity,
        liveness: { state: 'recent' as const, lastObservedAt: 10_500, ageMs: 500 },
      },
    };

    const renderer = await renderInAct(<BackgroundTasksPanel tasks={[stalled, fresh]} now={11_000} columns={120} />);
    const output = renderer.lastFrame() ?? '';
    expect(output).toContain('7 tools');
    expect(output).toContain('1 tool');
    expect(output).not.toContain('1 tools');
    expect(output).toContain('gpt-4o');

    expect(output).toContain('no activity observed for 10s');
    expect(output).toContain('0s ago');
  },
);

it.sequential(
  'shows the last output line of a running shell task in place of the generic observation text',
  async () => {
    const task = {
      kind: 'shell' as const,
      id: 'output-preview',
      command: 'pnpm build',
      status: 'running' as const,
      startedAt: 1_000,
      output: 'compiling module a\ncompiling module b\n\n',
      activity: {
        phase: 'active' as const,
        lastObservation: { kind: 'shell_output_received' as const, at: 1_000 },
        liveness: { state: 'recent' as const, lastObservedAt: 1_000, ageMs: 500 },
      },
    };
    const renderer = await renderInAct(<BackgroundTasksPanel tasks={[task]} now={1_500} columns={120} />);
    const output = renderer.lastFrame() ?? '';
    expect(output).toContain('"compiling module b"');
    expect(output).not.toContain('Shell output received');
  },
);

it.each([
  {
    columns: 40,
    task: {
      kind: 'subagent' as const,
      id: 'named-narrow',
      name: 'critical_identity',
      role: 'explorer',
      task: 'audit every provider lifecycle boundary',
      taskPreview: 'audit every provider lifecycle boundary',
      status: 'running' as const,
      startedAt: 1_000,
      elapsedMs: 10_000,
      toolCounts: {},
      activity: {
        phase: 'waiting' as const,
        reason: 'provider' as const,
        lastObservation: { kind: 'request_dispatched' as const, at: 1_000 },
        liveness: { state: 'quiet' as const, lastObservedAt: 1_000, ageMs: 10_000 },
      },
    },
    identity: 'critical',
    phase: 'Waiting',
  },
  {
    columns: 71,
    task: mergeLiveTaskRows({
      foreground: [
        {
          kind: 'subagent' as const,
          runId: 'foreground-width',
          role: 'worker',
          task: 'inspect foreground transfer ownership',
          status: 'running' as const,
          startedAt: 1_000,
        },
      ],
    }),
    identity: 'inspect foreground',
    phase: 'Running',
    foreground: true,
  },
  {
    columns: 72,
    task: {
      kind: 'shell' as const,
      id: 'shell-width',
      command: 'pnpm test -- source/components/layout with a deliberately long suffix',
      status: 'running' as const,
      startedAt: 1_000,
      activity: {
        phase: 'active' as const,
        lastObservation: { kind: 'shell_output_received' as const, at: 1_000 },
        liveness: { state: 'recent' as const, lastObservedAt: 1_000, ageMs: 1_000 },
      },
    },
    identity: 'pnpm test',
    phase: 'Active',
  },
  {
    columns: 103,
    task: runningTask({
      status: 'completed',
      completedAt: 2_000,
      task: 'retained terminal identity remains visible',
    }),
    identity: 'retained terminal identity',
    phase: 'Completed',
  },
  {
    columns: 104,
    task: {
      kind: 'subagent' as const,
      id: 'wide-context',
      name: 'wide_identity',
      role: 'explorer',
      task: 'audit provider fixtures for exact wide threshold behavior',
      taskPreview: 'audit provider fixtures for exact wide threshold behavior',
      status: 'running' as const,
      startedAt: 1_000,
      elapsedMs: 10_000,
      toolCounts: {},
      model: { provider: 'openai', id: 'gpt-4o', contextWindow: 128_000 },
      latestUsage: { prompt_tokens: 120_000 },
      activity: {
        phase: 'waiting' as const,
        reason: 'provider' as const,
        lastObservation: { kind: 'request_dispatched' as const, at: 1_000 },
        liveness: { state: 'quiet' as const, lastObservedAt: 1_000, ageMs: 10_000 },
      },
    },
    identity: 'wide_identity',
    phase: 'Awaiting provider response',
    context: 'Ctx 120k / 128k (93.8%)',
  },
])(
  'reserves identity and phase within a real $columns-column Ink layout',
  ({ columns, task, identity, phase, foreground, context }) => {
    const tasks = (Array.isArray(task) ? task : [task]) as React.ComponentProps<typeof BackgroundTasksPanel>['tasks'];
    const output = renderToString(<BackgroundTasksPanel tasks={tasks} now={11_000} columns={columns} />, { columns });
    const taskLine = output.split('\n').find((line) => line.startsWith('• ')) ?? '';
    expect(taskLine).toContain(identity);
    expect(taskLine).toContain(phase);
    expect(taskLine.length).toBeLessThanOrEqual(columns);
    if (foreground) expect(taskLine).toContain('foreground');
    if (context) expect(output).toContain(context);
    for (const line of output.split('\n')) expect(line.length).toBeLessThanOrEqual(columns);
  },
);

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
  expect(output).toContain('Tasks · 0 active');
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
              activity: {
                phase: 'active',
                lastObservation: { kind: 'text_received', at: 2_000 },
                liveness: { state: 'recent', lastObservedAt: 2_000, ageMs: 2_000 },
              },
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
              activity: {
                phase: 'waiting',
                reason: 'provider',
                lastObservation: { kind: 'request_dispatched', at: 3_000 },
                liveness: { state: 'recent', lastObservedAt: 3_000, ageMs: 1_000 },
              },
            },
            {
              kind: 'shell',
              id: 'quiet-shell',
              command: 'tail -f log',
              status: 'running',
              startedAt: 1_000,
              activity: {
                phase: 'active',
                lastObservation: { kind: 'shell_output_received', at: 1_000 },
                liveness: { state: 'quiet', lastObservedAt: 1_000, ageMs: 3_000 },
              },
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
              activity: {
                phase: 'settled',
                lastObservation: { kind: 'settled', at: 4_000 },
                liveness: { state: 'recent', lastObservedAt: 4_000, ageMs: 0 },
              },
              error: 'exit 1',
            },
          ] as any
        }
        now={4_000}
      />,
    );

    const output = renderer.lastFrame() ?? '';
    expect(output).toContain('Active');
    expect(output).toContain('Waiting');
    expect(output).toContain('Text received');
    expect(output).toContain('Shell output received');
    expect(output).toContain('Failed · terminal');
    expect(output).not.toContain('hung');
  },
);

it.sequential('drops each settled row once its linger expires, leaving still-running rows', async () => {
  const finished = runningTask({ runId: 'run-done', task: 'finished work', status: 'completed' });
  const running = runningTask({ runId: 'run-live', task: 'ongoing work' });
  const renderer = await renderInAct(<BackgroundTasksPanel tasks={[finished, running]} now={10_000} />);

  expect(renderer.lastFrame() ?? '').toContain('finished work');
  expect(renderer.lastFrame() ?? '').toContain('Tasks · 1 active');

  await rerenderInAct(renderer, <BackgroundTasksPanel tasks={[finished, running]} now={16_000} />);

  const output = renderer.lastFrame() ?? '';
  expect(output).not.toContain('finished work');
  expect(output).toContain('ongoing work');
  expect(output).toContain('Tasks · 1 active');
});

it.sequential('hides the whole panel once every row has settled and lingered', async () => {
  const finished = runningTask({ runId: 'run-done', status: 'completed' });
  const renderer = await renderInAct(<BackgroundTasksPanel tasks={[finished]} now={10_000} />);

  expect(renderer.lastFrame() ?? '').toContain('Tasks · 0 active');

  await rerenderInAct(renderer, <BackgroundTasksPanel tasks={[finished]} now={16_000} />);

  expect(renderer.lastFrame() ?? '').toBe('');
});

it.sequential('tags unadopted work as foreground and leaves adopted rows untagged', async () => {
  const renderer = await renderInAct(
    <BackgroundTasksPanel
      tasks={mergeLiveTaskRows({
        foreground: [
          {
            kind: 'subagent',
            runId: 'child-1',
            role: 'explorer',
            task: 'audit provider fixtures',
            status: 'running',
            startedAt: 1_000,
          },
          {
            kind: 'shell',
            callId: 'call-1',
            jobId: 'job-1',
            command: 'pnpm test',
            status: 'running',
            startedAt: 2_000,
          },
        ],
        background: [runningTask({ task: 'write the report' })],
      })}
      now={4_000}
    />,
  );

  const output = renderer.lastFrame() ?? '';
  expect(output).toContain('Tasks · 3 active');
  expect(output).toContain('[Explorer · foreground]');
  expect(output).toContain('audit provider fixtures');
  expect(output).toContain('[Shell · foreground]');
  expect(output).toContain('pnpm test');
  expect(output).toContain('[Explorer]');
  expect(output).toContain('write the report');
  expect(output).toContain('Running · 3s');
});
