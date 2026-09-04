import { it, expect, describe, vi } from 'vitest';
import {
  createRunSubagentAsyncToolDefinition,
  createGetSubagentResultToolDefinition,
  createGetSubagentStatusToolDefinition,
  createSendMessageToolDefinition,
  createCancelRunToolDefinition,
} from './run-subagent-async.js';
import type { SubagentRunHandle, SubagentResult, SubagentRunStatus } from '../../services/subagents/types.js';
import { SubagentRegistryError } from '../../services/subagents/subagent-async-registry.js';

function makeHandle(overrides: Partial<SubagentRunHandle> = {}): SubagentRunHandle {
  return {
    runId: 'run-123',
    role: 'explorer',
    task: 'find files',
    status: 'running',
    ...overrides,
  };
}

function makeStatus(overrides: Partial<SubagentRunStatus> = {}): SubagentRunStatus {
  return {
    runId: 'run-123',
    role: 'explorer',
    status: 'running',
    task: 'find files',
    taskPreview: 'find files',
    startedAt: 1000,
    elapsedMs: 5000,
    toolCounts: { read_file: 2, grep: 1 },
    lastToolName: 'grep',
    lastToolAt: 4500,
    ...overrides,
  };
}

function makeResult(overrides: Partial<SubagentResult> = {}): SubagentResult {
  return {
    agentId: 'run-123',
    role: 'explorer',
    status: 'completed',
    finalText: 'Found the relevant files.',
    filesChanged: [],
    toolsUsed: [],
    ...overrides,
  };
}

it('run_subagent_async tool is registered with the correct name', () => {
  const tool = createRunSubagentAsyncToolDefinition(async () => makeHandle());
  expect(tool.name).toBe('run_subagent_async');
});

it('run_subagent_async tool guidance treats a running handle as successful non-duplicated delegation', () => {
  const tool = createRunSubagentAsyncToolDefinition(async () => makeHandle());

  expect(tool.description).toContain('status: "running"');
  expect(tool.description).toContain('do not duplicate the delegated task');
  expect(tool.description).toContain('completion notification');
  expect(tool.description).toContain('do NOT immediately call tools.get_subagent_result(...)');
});

it('run_subagent_async schema accepts supported roles', () => {
  const tool = createRunSubagentAsyncToolDefinition(async () => makeHandle());

  for (const role of ['explorer', 'mentor']) {
    expect(tool.parameters.safeParse({ role, task: 'do work' }).success).toBe(true);
  }
  expect(tool.parameters.safeParse({ role: 'worker', task: 'do work' }).success).toBe(true);
  expect(tool.parameters.safeParse({ role: 'librarian', task: 'do work' }).success).toBe(false);
  expect(tool.parameters.safeParse({ role: 'unknown', task: 'do work' }).success).toBe(false);
});

it('run_subagent_async requires a task', () => {
  const tool = createRunSubagentAsyncToolDefinition(async () => makeHandle());

  expect(tool.parameters.shape.task.description).toContain('breadth or depth, never both');
  expect(tool.parameters.safeParse({ role: 'explorer', task: 'find files' }).success).toBe(true);
  expect(tool.parameters.safeParse({ role: 'explorer' }).success).toBe(false);
});

it('run_subagent_async accepts only constrained optional active-run names', () => {
  const tool = createRunSubagentAsyncToolDefinition(async () => makeHandle());

  for (const name of ['a', 'code_scan', 'worker-2', 'x'.repeat(32)]) {
    expect(tool.parameters.safeParse({ role: 'explorer', task: 'find files', name }).success).toBe(true);
  }
  for (const name of ['Uppercase', '-leading', 'has space', 'x'.repeat(33)]) {
    expect(tool.parameters.safeParse({ role: 'explorer', task: 'find files', name }).success).toBe(false);
  }
});

it('run_subagent_async returns a run handle string', async () => {
  const tool = createRunSubagentAsyncToolDefinition(async () => makeHandle({ runId: 'run-abc' }));

  const raw = (await tool.execute({ role: 'explorer', task: 'find files' })) as string;

  expect(raw).toContain('run-abc');
});

it('run_subagent_async exposes an optional active-run name in its acknowledgement', async () => {
  const tool = createRunSubagentAsyncToolDefinition(async () => makeHandle({ name: 'code_scan' }));

  const raw = (await tool.execute({ role: 'explorer', task: 'find files', name: 'code_scan' })) as string;

  expect(raw).toContain('code_scan');
});

it('get_subagent_result tool is registered with the correct name', () => {
  const tool = createGetSubagentResultToolDefinition(
    async () => makeResult(),
    () => makeStatus({ status: 'completed' }),
  );
  expect(tool.name).toBe('get_subagent_result');
});

it('get_subagent_result schema requires a runId', () => {
  const tool = createGetSubagentResultToolDefinition(
    async () => makeResult(),
    () => makeStatus({ status: 'completed' }),
  );

  expect(tool.parameters.safeParse({ runId: 'run-abc' }).success).toBe(true);
  expect(tool.parameters.safeParse({}).success).toBe(false);
});

it('get_subagent_result returns a formatted SubagentResult', async () => {
  const tool = createGetSubagentResultToolDefinition(
    async () => makeResult({ finalText: 'Answer here.' }),
    () => makeStatus({ status: 'completed' }),
  );

  const raw = (await tool.execute({ runId: 'run-abc' })) as string;

  expect(raw).toContain('Status: completed');
  expect(raw).toContain('Answer here.');
  expect(raw.startsWith('{')).toBe(false);
});

it('get_subagent_result refuses an active background run without awaiting its result', async () => {
  const getResult = vi.fn(async () => makeResult());
  const tool = createGetSubagentResultToolDefinition(getResult, () => makeStatus({ status: 'running' }));

  await expect(tool.execute({ runId: 'run-123' })).resolves.toBe(
    JSON.stringify({
      status: 'background_run_active',
      runId: 'run-123',
      message:
        'This background subagent is still running. End the current turn and wait for its automatic completion notification; do not call tools.get_subagent_result(...) again inside run_code.',
    }),
  );
  expect(getResult).not.toHaveBeenCalled();
});

it('get_subagent_result directs an answer-blocked subagent to send_message instead of waiting', async () => {
  const getResult = vi.fn(async () => makeResult());
  const tool = createGetSubagentResultToolDefinition(getResult, () => makeStatus({ status: 'waiting_for_answer' }));

  await expect(tool.execute({ runId: 'run-123' })).resolves.toBe(
    JSON.stringify({
      status: 'background_run_waiting_for_answer',
      runId: 'run-123',
      message:
        'This background subagent is waiting for your answer. Inside run_code, use tools.send_message(...) with its messageId to resume it; do not call tools.get_subagent_result(...).',
    }),
  );
  expect(getResult).not.toHaveBeenCalled();
});

it('get_subagent_result renders structured validation and diffStat evidence', async () => {
  const tool = createGetSubagentResultToolDefinition(
    async () =>
      makeResult({
        finalText: 'Done.',
        diffStat: [
          { path: 'src/a.ts', added: 10, deleted: 3 },
          { path: 'src/b.ts', added: 5, deleted: 0 },
        ],
        validation: {
          command: 'pnpm vitest run',
          exitStatus: 0,
          outputExcerpt: 'Tests passed',
        },
      }),
    () => makeStatus({ status: 'completed' }),
  );

  const raw = (await tool.execute({ runId: 'run-abc' })) as string;
  // Structured evidence appears.
  expect(raw).toContain('Validation: pnpm vitest run');
  expect(raw).toContain('exit 0');
  expect(raw).toContain('Diff stat:');
  expect(raw).toContain('src/a.ts +10/-3');
  expect(raw).toContain('src/b.ts +5/-0');
  // Narrative still appears.
  expect(raw).toContain('Done.');
});

it('preserves registry error codes through the async tool boundary', async () => {
  const tool = createRunSubagentAsyncToolDefinition(async () => {
    throw new SubagentRegistryError('worker_blocked', 'Worker runs cannot be continued asynchronously');
  });

  await expect(tool.execute({ role: 'worker', task: 'continue', continue_run_id: 'run-abc' })).resolves.toBe(
    JSON.stringify({
      status: 'failed',
      error: { code: 'worker_blocked', message: 'Worker runs cannot be continued asynchronously' },
    }),
  );
});

it('get_subagent_result returns failed result text on error', async () => {
  const tool = createGetSubagentResultToolDefinition(
    async () => {
      throw new Error('Run not found');
    },
    () => makeStatus({ status: 'completed' }),
  );

  const raw = (await tool.execute({ runId: 'run-abc' })) as string;

  expect(raw).toContain('Status: failed');
  expect(raw).toContain('Run not found');
});

it('run_subagent_async formatCommandMessage renders started async run', () => {
  const tool = createRunSubagentAsyncToolDefinition(async () => makeHandle());

  const item = {
    rawItem: {
      arguments: JSON.stringify({ role: 'explorer', task: 'find files' }),
      output: 'Started async run run-123',
    },
  };

  const messages = tool.formatCommandMessage(item, 0, new Map());
  expect(messages.length).toBe(1);
  expect(messages[0].command).toContain('run_subagent_async');
  expect(messages[0].command).toContain('explorer');
  expect(messages[0].command).toContain('find files');
});

it('get_subagent_result formatCommandMessage renders completed result', () => {
  const tool = createGetSubagentResultToolDefinition(
    async () => makeResult(),
    () => makeStatus({ status: 'completed' }),
  );

  const item = {
    rawItem: {
      arguments: JSON.stringify({ runId: 'run-123' }),
      output: 'Status: completed\n\nFound the relevant files.',
    },
  };

  const messages = tool.formatCommandMessage(item, 0, new Map());
  expect(messages.length).toBe(1);
  expect(messages[0].command).toContain('get_subagent_result');
  expect(messages[0].output).toContain('Found the relevant files.');
  expect(messages[0].success).toBe(true);
});

describe('get_subagent_status tool', () => {
  it('is registered with the correct name', () => {
    const tool = createGetSubagentStatusToolDefinition(() => makeStatus());
    expect(tool.name).toBe('get_subagent_status');
  });

  it('never needs approval', () => {
    const tool = createGetSubagentStatusToolDefinition(() => makeStatus());
    expect(tool.needsApproval({} as any)).toBe(false);
  });

  it('description states the non-blocking contract and the boundary with get_subagent_result', () => {
    const tool = createGetSubagentStatusToolDefinition(() => makeStatus());
    expect(tool.description).toContain('never blocks');
    expect(tool.description).toContain('get_subagent_result');
    expect(tool.description).toContain('never the final report');
  });

  it('accepts an optional runId (single run or all-runs listing)', () => {
    const tool = createGetSubagentStatusToolDefinition(() => makeStatus());
    expect(tool.parameters.safeParse({ runId: 'run-abc' }).success).toBe(true);
    expect(tool.parameters.safeParse({}).success).toBe(true);
  });

  it('formats a single running run and references the completion notification', () => {
    const tool = createGetSubagentStatusToolDefinition(() => makeStatus());
    const raw = tool.execute({ runId: 'run-123' }) as string;
    expect(raw).toContain('running');
    expect(raw).toContain('grep');
    expect(raw).toContain('completion notification');
    // Peek must not leak completion detail.
    expect(raw).not.toContain('final');
    expect(raw.startsWith('{')).toBe(false);
  });

  it('includes shared recent liveness evidence for a running subagent', () => {
    const tool = createGetSubagentStatusToolDefinition(
      () =>
        makeStatus({
          activityState: 'active',
          lastObservation: { kind: 'text_received', at: 1_000 },
        }),
      () => 30_000,
    );

    expect(tool.execute({ runId: 'run-123' })).toContain('active, recent; last observed 29s ago');
  });

  it('keeps provider waiting separate from quiet evidence age', () => {
    const tool = createGetSubagentStatusToolDefinition(
      () =>
        makeStatus({
          activityState: 'waiting',
          waitingReason: 'provider',
          lastActivityAt: 0,
        }),
      () => 8 * 60_000,
    );

    const raw = tool.execute({ runId: 'run-123' });
    expect(raw).toContain('waiting (provider), quiet; last observed 8m ago');
    expect(raw).not.toContain('hung');
  });

  it('shows bounded in-flight tool argument progress without argument content', () => {
    const tool = createGetSubagentStatusToolDefinition(() =>
      makeStatus({
        streamingTool: { name: 'apply_patch', argumentCharCount: 43_503 },
        lastObservation: {
          kind: 'tool_input_received',
          at: 10_000,
          toolName: 'apply_patch',
          argumentCharCount: 43_503,
        },
      }),
    );

    const raw = tool.execute({ runId: 'run-123' });
    expect(raw).toContain('streamingTool: apply_patch (43503 argument chars)');
    expect(raw).not.toContain('operations');
  });

  it('does not invent liveness evidence when the status has no observation timestamp', () => {
    const tool = createGetSubagentStatusToolDefinition(
      () => makeStatus(),
      () => 8 * 60_000,
    );

    expect(tool.execute({ runId: 'run-123' })).not.toContain('liveness:');
  });

  it('formats completed text turns, streaming text, and pending tools for a rich peek', () => {
    const tool = createGetSubagentStatusToolDefinition(() =>
      makeStatus({
        turnHistory: [
          {
            text: 'Looking at config loading...',
            precedingToolCounts: { grep: 5, read_file: 3 },
            truncated: false,
          },
          {
            text: 'Found env overrides bypass validation',
            precedingToolCounts: { grep: 3, read_file: 2 },
            truncated: false,
          },
        ],
        currentText: 'Checking if there are tests...',
        pendingToolCounts: { grep: 2 },
      }),
    );

    const raw = tool.execute({ runId: 'run-123' }) as string;

    expect(raw).toContain('turn 1: Looking at config loading... → grep(5), read_file(3)');
    expect(raw).toContain('turn 2: Found env overrides bypass validation → grep(3), read_file(2)');
    expect(raw).toContain('streaming: "Checking if there are tests..."');
    expect(raw).toContain('pending: grep(2)');
  });

  it('treats a cancelling run as active until its runner settles', () => {
    const tool = createGetSubagentStatusToolDefinition(() => makeStatus({ status: 'cancelling' }));

    const raw = tool.execute({ runId: 'run-123' }) as string;

    expect(raw).toContain('cancelling');
    expect(raw).toContain('still in progress');
  });

  it('treats a run waiting for an orchestrator answer as active', () => {
    const tool = createGetSubagentStatusToolDefinition(() => makeStatus({ status: 'waiting_for_answer' }));

    const raw = tool.execute({ runId: 'run-123' }) as string;

    expect(raw).toContain('waiting_for_answer');
    expect(raw).toContain('still in progress');
    expect(raw).not.toContain('has finished');
  });

  it('formats an all-runs listing when runId is omitted', () => {
    const tool = createGetSubagentStatusToolDefinition(() => [
      makeStatus({ runId: 'run-a', role: 'explorer' }),
      makeStatus({
        runId: 'run-b',
        role: 'worker',
        status: 'running',
        task: 'edit',
        taskPreview: 'edit',
        toolCounts: { search_replace: 3 },
      }),
    ]);
    const raw = tool.execute({}) as string;
    expect(raw).toContain('run-a');
    expect(raw).toContain('run-b');
    expect(raw).toContain('explorer');
    expect(raw).toContain('worker');
  });

  it('displays an optional active-run name alongside the canonical runId', () => {
    const tool = createGetSubagentStatusToolDefinition(() => makeStatus({ name: 'code_scan' }));

    const raw = tool.execute({ runId: 'run-123' }) as string;

    expect(raw).toContain('code_scan (run-123)');
  });

  it('reports a not-found run without throwing', () => {
    const tool = createGetSubagentStatusToolDefinition(() =>
      makeStatus({
        runId: 'ghost',
        status: 'not_found',
        task: '',
        taskPreview: '',
        toolCounts: {},
        lastToolName: undefined,
        lastToolAt: undefined,
        elapsedMs: 0,
        startedAt: 0,
      }),
    );
    const raw = tool.execute({ runId: 'ghost' }) as string;
    expect(raw).toContain('not found');
  });

  it('execute is synchronous and does not await a run promise', () => {
    const tool = createGetSubagentStatusToolDefinition(() => makeStatus());
    // Structural assertion: execute does not return a Promise for the happy path.
    const out = tool.execute({ runId: 'run-123' });
    expect(typeof out).toBe('string');
  });
});

describe('async run control tools', () => {
  it('send_message queues bounded steering or an answer without approval or waiting for a result', () => {
    const send = vi.fn(() => ({
      ok: true as const,
      runId: 'run-123',
      status: 'running' as const,
      delivery: 'queued' as const,
    }));
    const tool = createSendMessageToolDefinition(send);

    expect(tool.name).toBe('send_message');
    expect(tool.needsApproval({ target: 'scan', message: 'Check the public API.' })).toBe(false);
    expect(tool.parameters.safeParse({ target: 'scan', message: 'Check the public API.' }).success).toBe(true);
    expect(tool.parameters.safeParse({ target: 'scan', message: 'Answer it.', reply_to: 'message-1' }).success).toBe(
      true,
    );
    expect(tool.parameters.safeParse({ target: '', message: 'Check this.' }).success).toBe(false);
    expect(tool.parameters.safeParse({ target: 'scan', message: 'x'.repeat(2_001) }).success).toBe(false);

    expect(tool.execute({ target: 'scan', message: 'Check the public API.' })).toBe(
      JSON.stringify({ ok: true, runId: 'run-123', status: 'running', delivery: 'queued' }),
    );
    expect(send).toHaveBeenCalledWith({ target: 'scan', message: 'Check the public API.', reply_to: undefined });
    expect(tool.description).toContain('fresh session turn');
    expect(tool.description).toContain('reply_to');
    expect(tool.description).toContain('mentor');
    expect(tool.description).toContain('Do not immediately call tools.get_subagent_result(...)');
  });

  it('cancel_run returns only a compact cancellation acknowledgement or typed inactive error', () => {
    const cancel = vi.fn(({ target }: { target: string }) =>
      target === 'missing'
        ? { ok: false as const, code: 'not_active' as const, target }
        : { ok: true as const, runId: 'run-123', status: 'cancelling' as const },
    );
    const tool = createCancelRunToolDefinition(cancel);

    expect(tool.name).toBe('cancel_run');
    expect(tool.needsApproval({ target: 'scan' })).toBe(false);
    expect(tool.parameters.safeParse({ target: 'scan' }).success).toBe(true);
    expect(tool.parameters.safeParse({}).success).toBe(false);
    expect(tool.execute({ target: 'scan' })).toBe(JSON.stringify({ ok: true, runId: 'run-123', status: 'cancelling' }));
    expect(tool.execute({ target: 'missing' })).toBe(
      JSON.stringify({ ok: false, code: 'not_active', target: 'missing' }),
    );
    expect(tool.description).toContain('does NOT wait');
    expect(tool.description).toContain('partial');
    expect(tool.description).toContain('Do not immediately call tools.get_subagent_result(...)');
  });

  it('formats control acknowledgements with target and status without exposing a full result', () => {
    const sendTool = createSendMessageToolDefinition(() => ({
      ok: true,
      runId: 'run-123',
      status: 'running',
      delivery: 'queued',
    }));
    const cancelTool = createCancelRunToolDefinition(() => ({ ok: true, runId: 'run-123', status: 'cancelling' }));

    const send = sendTool.formatCommandMessage(
      {
        rawItem: {
          arguments: JSON.stringify({ target: 'code_scan', message: 'A long internal result must not render here.' }),
          output: JSON.stringify({ ok: true, runId: 'run-123', status: 'running', delivery: 'queued' }),
        },
      },
      0,
      new Map(),
    )[0];
    const cancel = cancelTool.formatCommandMessage(
      {
        rawItem: {
          arguments: JSON.stringify({ target: 'code_scan' }),
          output: JSON.stringify({ ok: true, runId: 'run-123', status: 'cancelling' }),
        },
      },
      0,
      new Map(),
    )[0];

    expect(send.command).toContain('code_scan');
    expect(send.output).toContain('running');
    expect(send.output).not.toContain('A long internal result');
    expect(cancel.command).toContain('code_scan');
    expect(cancel.output).toContain('awaiting normal completion');
  });

  it('formats a typed full-mailbox acknowledgement with its effective capacity', () => {
    const tool = createSendMessageToolDefinition(() => ({
      ok: false,
      code: 'mailbox_full',
      target: 'code_scan',
      limits: { messages: 4, characters: 4_000 },
      occupancy: { messages: 4, characters: 22 },
    }));

    const formatted = tool.formatCommandMessage(
      {
        rawItem: {
          arguments: JSON.stringify({ target: 'code_scan', message: 'One more instruction.' }),
          output: JSON.stringify({
            ok: false,
            code: 'mailbox_full',
            target: 'code_scan',
            limits: { messages: 4, characters: 4_000 },
            occupancy: { messages: 4, characters: 22 },
          }),
        },
      },
      0,
      new Map(),
    )[0];

    expect(formatted.command).toContain('mailbox_full');
    expect(formatted.output).toContain('4/4 messages');
    expect(formatted.output).toContain('22/4000 characters');
  });
});
