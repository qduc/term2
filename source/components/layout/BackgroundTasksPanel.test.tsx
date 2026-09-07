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

it.sequential('keeps six-plus tasks to one rendered row each in a short terminal', async () => {
  const tasks = Array.from({ length: 7 }, (_, index) =>
    runningTask({
      runId: `run-${index}`,
      role: index % 2 === 0 ? 'worker' : 'explorer',
      task: `inspect background task ${index} and preserve the conversation viewport`,
      startedAt: 1_000 + index,
    }),
  );
  const renderer = await renderInAct(<BackgroundTasksPanel tasks={tasks} now={8_000} columns={40} />);
  const lines = (renderer.lastFrame() ?? '').split('\n').filter(Boolean);

  // Before the strip was compact, the same seven tasks could render a header,
  // an observation, and several tool rows per card. The strip is now exactly
  // one header plus one bounded row per visible task.
  expect(lines).toHaveLength(8);
  expect(lines.filter((line) => line.startsWith('• '))).toHaveLength(7);
  expect(lines.every((line) => line.length <= 40)).toBe(true);
});

// This is deliberately a real Ink layout assertion rather than a `columns`
// prop assertion. `renderInAct` uses ink-testing-library's fixed mock stdout,
// so renderToString's `{ columns }` option is the available width seam here.
// Ink's render-to-string API has no viewport-height option; this covers the
// width half of the short-terminal regression, not screen-height clipping.
it.each([120, 72])('keeps seven richly populated tasks to one bounded row at %s columns', (columns) => {
  const tasks = [
    {
      kind: 'subagent' as const,
      id: 'waiting-context',
      role: 'explorer',
      task: 'inspect provider request boundaries and report the stalled transition',
      taskPreview: 'inspect provider request boundaries and report the stalled transition',
      status: 'running' as const,
      startedAt: 1_000,
      elapsedMs: 30_000,
      toolCounts: { grep: 4, read_file: 3 },
      model: { provider: 'openai', id: 'gpt-4o', contextWindow: 128_000 },
      latestUsage: { prompt_tokens: 120_000 },
      activity: {
        phase: 'waiting' as const,
        reason: 'provider' as const,
        lastObservation: { kind: 'request_dispatched' as const, at: 1_000 },
        liveness: { state: 'quiet' as const, lastObservedAt: 1_000, ageMs: 30_000 },
      },
      recentTools: [
        { label: 'grep pattern=provider', state: 'success' as const },
        { label: 'read_file path=source/providers/runtime.ts', state: 'success' as const },
        { label: 'grep pattern=request boundary', state: 'running' as const },
      ],
    },
    {
      kind: 'subagent' as const,
      id: 'active-tools',
      role: 'worker',
      task: 'implement the compact activity rendering guard',
      taskPreview: 'implement the compact activity rendering guard',
      status: 'running' as const,
      startedAt: 2_000,
      elapsedMs: 29_000,
      toolCounts: { read_file: 5, apply_patch: 1 },
      model: { provider: 'anthropic', id: 'claude-sonnet', contextWindow: 200_000 },
      latestUsage: { prompt_tokens: 84_000 },
      activity: {
        phase: 'active' as const,
        lastObservation: { kind: 'tool_started' as const, at: 29_000, toolName: 'apply_patch' },
        liveness: { state: 'recent' as const, lastObservedAt: 29_000, ageMs: 1_000 },
      },
      recentTools: [
        { label: 'read_file path=source/components/layout/BackgroundTasksPanel.tsx', state: 'success' as const },
        { label: 'apply_patch compact rows', state: 'running' as const },
      ],
    },
    {
      kind: 'shell' as const,
      id: 'build-output',
      command: 'pnpm build --filter terminal-ui --verbose',
      status: 'running' as const,
      startedAt: 3_000,
      activity: {
        phase: 'active' as const,
        lastObservation: { kind: 'shell_output_received' as const, at: 29_500 },
        liveness: { state: 'recent' as const, lastObservedAt: 29_500, ageMs: 500 },
      },
      output: 'compiling layout/BackgroundTasksPanel.tsx\nwriting dist/cli.js\n',
    },
    {
      kind: 'subagent' as const,
      id: 'approval-wait',
      role: 'worker',
      task: 'check approval routing around nested tool execution',
      taskPreview: 'check approval routing around nested tool execution',
      status: 'running' as const,
      startedAt: 4_000,
      elapsedMs: 28_000,
      toolCounts: { read_file: 2 },
      model: { provider: 'openai', id: 'gpt-5', contextWindow: 272_000 },
      latestUsage: { prompt_tokens: 55_000 },
      activity: {
        phase: 'waiting' as const,
        reason: 'approval' as const,
        lastObservation: { kind: 'approval_requested' as const, at: 29_000 },
        liveness: { state: 'recent' as const, lastObservedAt: 29_000, ageMs: 1_000 },
      },
      recentTools: [{ label: 'run_code script=approval-check', state: 'success' as const }],
    },
    {
      kind: 'shell' as const,
      id: 'test-output',
      command: 'pnpm test source/components/layout --runInBand',
      status: 'running' as const,
      startedAt: 5_000,
      activity: {
        phase: 'active' as const,
        lastObservation: { kind: 'shell_output_received' as const, at: 29_000 },
        liveness: { state: 'quiet' as const, lastObservedAt: 29_000, ageMs: 1_000 },
      },
      output: 'BackgroundTasksPanel.test.tsx 7 passed\nBackgroundTaskManager.test.tsx 12 passed\n',
    },
    {
      kind: 'subagent' as const,
      id: 'question-wait',
      role: 'explorer',
      task: 'trace the conversation viewport ownership across layout boundaries',
      taskPreview: 'trace the conversation viewport ownership across layout boundaries',
      status: 'running' as const,
      startedAt: 6_000,
      elapsedMs: 27_000,
      toolCounts: { glob: 2, read_file: 6 },
      model: { provider: 'openrouter', id: 'deepseek-r1', contextWindow: 64_000 },
      latestUsage: { prompt_tokens: 40_000 },
      activity: {
        phase: 'waiting' as const,
        reason: 'answer' as const,
        lastObservation: { kind: 'question_asked' as const, at: 29_500 },
        liveness: { state: 'recent' as const, lastObservedAt: 29_500, ageMs: 500 },
      },
      recentTools: [
        { label: 'glob pattern=source/components/**/*.tsx', state: 'success' as const },
        { label: 'read_file path=source/components/layout/BottomArea.tsx', state: 'success' as const },
      ],
    },
    {
      kind: 'subagent' as const,
      id: 'quiet-worker',
      role: 'worker',
      task: 'review terminal width budget and retain task identity',
      taskPreview: 'review terminal width budget and retain task identity',
      status: 'running' as const,
      startedAt: 7_000,
      elapsedMs: 26_000,
      toolCounts: { grep: 8 },
      model: { provider: 'openai', id: 'gpt-4o-mini', contextWindow: 128_000 },
      latestUsage: { prompt_tokens: 24_000 },
      activity: {
        phase: 'active' as const,
        lastObservation: { kind: 'text_received' as const, at: 29_500 },
        liveness: { state: 'quiet' as const, lastObservedAt: 7_000, ageMs: 22_500 },
      },
      recentTools: [{ label: 'grep pattern=BACKGROUND_TASK_PANEL', state: 'success' as const }],
    },
  ] as React.ComponentProps<typeof BackgroundTasksPanel>['tasks'];

  const output = renderToString(<BackgroundTasksPanel tasks={tasks} now={30_000} columns={columns} />, { columns });
  const lines = output.split('\n').filter((line) => line.trim().length > 0);
  const taskLines = lines.filter((line) => line.startsWith('• '));

  expect(lines).toHaveLength(tasks.length + 1);
  expect(lines[0]).toContain(`Tasks · ${tasks.length} active`);
  expect(taskLines).toHaveLength(tasks.length);
  expect(taskLines.every((line) => line.length <= columns)).toBe(true);
  expect(lines.every((line) => line.length <= columns)).toBe(true);
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

it.sequential('uses explicit wide, medium, and narrow label budgets without expanding task rows', async () => {
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
    expect(renderer.lastFrame() ?? '').toContain('Awaiting provider response');
    expect(renderer.lastFrame() ?? '').not.toContain('no activity observed for 10s');
    expect(renderer.lastFrame() ?? '').not.toContain('Ctx 120k');
    await rerenderInAct(renderer, <BackgroundTasksPanel tasks={[task]} now={11_000} columns={72} />);
    expect(renderer.lastFrame() ?? '').toContain('audit provider fixtures for stalle…');
    expect(renderer.lastFrame() ?? '').toContain(' · Waiting');
    expect(renderer.lastFrame() ?? '').not.toContain('Request handed to model runtime');
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

it.sequential('keeps liveness and model telemetry in the manager instead of expanding strip rows', async () => {
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
  expect(output.split('\n').filter((line) => line.startsWith('• '))).toHaveLength(2);
  expect(output).not.toContain('7 tools');
  expect(output).not.toContain('gpt-4o');
  expect(output).not.toContain('no activity observed for 10s');
});

it.sequential('keeps shell output out of the compact strip', async () => {
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
  expect(output).toContain('[Shell] pnpm build');
  expect(output).not.toContain('compiling module b');
  expect(output).not.toContain('Shell output received');
});

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
  },
])(
  'reserves identity and phase within a real $columns-column Ink layout',
  ({ columns, task, identity, phase, foreground }) => {
    const tasks = (Array.isArray(task) ? task : [task]) as React.ComponentProps<typeof BackgroundTasksPanel>['tasks'];
    const output = renderToString(<BackgroundTasksPanel tasks={tasks} now={11_000} columns={columns} />, { columns });
    const taskLine = output.split('\n').find((line) => line.startsWith('• ')) ?? '';
    expect(taskLine).toContain(identity);
    expect(taskLine).toContain(phase);
    expect(taskLine.length).toBeLessThanOrEqual(columns);
    if (foreground) expect(taskLine).toContain('foreground');
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

it.sequential('does not render a tool row for a task with recent tool activity', async () => {
  const renderer = await renderInAct(
    <BackgroundTasksPanel
      tasks={[runningTask({ lastTool: { label: 'grep "TODO" src/', state: 'running' } })]}
      now={1_000}
    />,
  );

  const output = renderer.lastFrame() ?? '';
  expect(output).toContain('Explorer');
  expect(output).not.toContain('└');
  expect(output).not.toContain('grep "TODO" src/');
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
  'renders budget-exhausted interrupted tasks as terminal at normal and narrow widths, then ages them out',
  async () => {
    const interrupted = runningTask({
      status: 'interrupted',
      completedAt: 6_000,
      task: 'partially completed work',
    });
    const renderer = await renderInAct(<BackgroundTasksPanel tasks={[interrupted]} now={7_000} columns={120} />);

    let output = renderer.lastFrame() ?? '';
    expect(output).toContain('Tasks · 0 active');
    expect(output).toContain('Interrupted recently (budget exhausted)');
    expect(output).not.toContain('Running');

    await rerenderInAct(renderer, <BackgroundTasksPanel tasks={[interrupted]} now={7_000} columns={40} />);
    output = renderer.lastFrame() ?? '';
    expect(output).toContain('Interrupted');
    expect(output).not.toContain('Running');

    await rerenderInAct(renderer, <BackgroundTasksPanel tasks={[interrupted]} now={16_000} columns={40} />);
    expect(renderer.lastFrame() ?? '').toBe('');
  },
);

it.sequential('keeps activity observations and terminal errors to one row per task', async () => {
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
  expect(output).toContain('Failed · terminal');
  expect(output).not.toContain('Text received');
  expect(output).not.toContain('Shell output received');
  expect(output).not.toContain('hung');
  expect(output.split('\n').filter((line) => line.startsWith('• '))).toHaveLength(4);
});

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
