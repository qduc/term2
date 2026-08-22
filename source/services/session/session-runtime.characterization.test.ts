import { expect, it } from 'vitest';
import { createSessionRuntime } from '../../core/index.js';
import type { ConversationEvent } from '../conversation/conversation-events.js';
import type { ConversationAgentClient } from '../conversation-agent-client.js';
import { ToolOwnershipRegistry } from '../approval/tool-ownership-registry.js';
import { MockStream } from '../test-helpers/mock-stream.js';
import {
  createMockAgentClient,
  createMockSettingsService,
  mockLogger,
  sessionContextService,
} from './test-helpers/conversation-session-fixtures.js';

const collect = async (events: AsyncIterable<ConversationEvent>): Promise<ConversationEvent[]> => {
  const collected: ConversationEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
};

const finalStream = (text: string): MockStream => {
  const stream = new MockStream([{ type: 'text_delta', text }]);
  stream.finalOutput = text;
  stream.lastResponseId = `response-${text}`;
  return stream;
};

const interruptedStream = ({
  callId,
  toolName = 'shell',
  argumentsValue = { command: 'echo approval' },
}: {
  callId: string;
  toolName?: string;
  argumentsValue?: Record<string, unknown>;
}): MockStream => {
  const stream = new MockStream([]);
  stream.interruptions = [
    {
      name: toolName,
      callId,
      agent: { name: 'test-agent' },
      arguments: JSON.stringify(argumentsValue),
    },
  ];
  stream.state = {
    approve: () => undefined,
    reject: () => undefined,
  };
  return stream;
};

const runtimeFor = (sessionId: string, agentClient: ConversationAgentClient, options: Record<string, unknown> = {}) =>
  createSessionRuntime({
    sessionId,
    agentClient,
    toolOwnership: new ToolOwnershipRegistry(),
    deps: {
      logger: mockLogger,
      settingsService: createMockSettingsService([
        ['agent.provider', 'test-provider'],
        ['agent.model', 'test-model'],
      ]),
      sessionContextService,
    },
    ...options,
  } as never);

it('runs one headless turn through the public core seam and records completion state', async () => {
  const stream = finalStream('hello');
  const runtime = runtimeFor('public-turn', createMockAgentClient({ startStream: async () => stream }));

  try {
    const events = await collect(runtime.turns.start('hello'));
    expect(events.map((event) => event.type)).toEqual(['text_delta', 'final']);
    expect(events.at(-1)).toMatchObject({ type: 'final', finalText: 'hello' });
    expect(runtime.state.getCurrentSnapshot().history.length).toBeGreaterThan(0);
  } finally {
    await runtime.shutdown();
  }
});

it('pauses for approval and resumes through the public runtime seam', async () => {
  const initial = interruptedStream({ callId: 'approval-1' });
  const continuation = finalStream('approved');
  const runtime = runtimeFor(
    'public-approval',
    createMockAgentClient({
      startStream: async () => initial,
      continueRunStream: async () => continuation,
    }),
  );

  try {
    const paused = await collect(runtime.turns.start('run a command'));
    expect(paused.at(-1)?.type).toBe('approval_required');
    expect(runtime.approval.getPending()).not.toBeNull();
    expect(runtime.pendingInteraction.getSnapshot()).toBeNull();

    const resumed = await collect(runtime.turns.continueAfterApproval({ answer: 'y' }));
    expect(resumed.at(-1)).toMatchObject({ type: 'final', finalText: 'approved' });
    expect(runtime.approval.getPending()).toBeNull();
    expect(runtime.state.getCurrentSnapshot().previousResponseId).toBe('response-approved');
  } finally {
    await runtime.shutdown();
  }
});

it('answers ask_user through the public raw-sink protocol and resumes to final', async () => {
  const answers: Array<{ callId: string; answer: string }> = [];
  const answerSink = {
    setAskUserAnswer(callId: string, answer: string) {
      answers.push({ callId, answer });
    },
  };
  const runtime = runtimeFor(
    'public-ask-user',
    createMockAgentClient({
      startStream: async () =>
        interruptedStream({
          callId: 'ask-1',
          toolName: 'ask_user',
          argumentsValue: { questions: [{ question: 'Which option?' }] },
        }),
      continueRunStream: async () => finalStream('answered'),
    }),
    { askUserAnswerSink: answerSink },
  );

  try {
    const paused = await collect(runtime.turns.start('ask me'));
    expect(paused.at(-1)).toMatchObject({ type: 'approval_required' });
    expect(runtime.approval.getPending()).toMatchObject({ interruption: { callId: 'ask-1' } });
    const pending = runtime.approval.getPending();
    const callId = (pending?.interruption as { callId?: string } | undefined)?.callId;
    expect(callId).toBe('ask-1');
    expect(runtime.sinks.askUserAnswer).toBe(answerSink);
    runtime.sinks.askUserAnswer?.setAskUserAnswer(callId ?? '', 'option B');
    const resumed = await collect(runtime.turns.continueAfterApproval({ answer: 'y' }));
    expect(resumed.at(-1)).toMatchObject({ type: 'final', finalText: 'answered' });
    expect(answers).toEqual([{ callId: 'ask-1', answer: 'option B' }]);
  } finally {
    await runtime.shutdown();
  }
});

it('aborts a gated turn and prevents continuation of an approval pause', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  class GatedStream extends MockStream {
    async *[Symbol.asyncIterator](): AsyncGenerator<unknown, void, unknown> {
      yield { type: 'text_delta', text: 'partial' };
      await gate;
    }
  }

  const gated = new GatedStream([]);
  const abortCalls: number[] = [];
  const runtime = runtimeFor(
    'public-abort',
    createMockAgentClient({
      abort: () => {
        abortCalls.push(1);
        release();
      },
      startStream: async () => gated,
    }),
  );

  const iterator = runtime.turns.start('abort me')[Symbol.asyncIterator]();
  try {
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'text_delta' }, done: false });
    runtime.turns.abort();
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
    expect(abortCalls).toHaveLength(1);
    expect(runtime.approval.getPending()).toBeNull();
  } finally {
    release();
    await runtime.shutdown();
  }

  const approvalRuntime = runtimeFor(
    'public-abort-approval',
    createMockAgentClient({ startStream: async () => interruptedStream({ callId: 'abort-approval' }) }),
  );
  try {
    await collect(approvalRuntime.turns.start('pause'));
    approvalRuntime.turns.abort();
    expect(approvalRuntime.approval.getPending()).toBeNull();
    await expect(collect(approvalRuntime.turns.continueAfterApproval({ answer: 'y' }))).rejects.toThrow(
      'No pending approval',
    );
  } finally {
    await approvalRuntime.shutdown();
  }
});

it('emits one public-seam tool_started event for duplicate SDK function calls', async () => {
  const stream = new MockStream([
    {
      type: 'item',
      item: {
        rawItem: {
          type: 'function_call',
          callId: 'tool-1',
          name: 'shell',
          arguments: JSON.stringify({ command: 'echo hi' }),
        },
      },
    },
    {
      type: 'item',
      item: {
        rawItem: {
          type: 'function_call',
          callId: 'tool-1',
          name: 'shell',
          arguments: JSON.stringify({ command: 'echo hi' }),
        },
      },
    },
  ]);
  stream.finalOutput = 'tool complete';
  const runtime = runtimeFor('public-tool', createMockAgentClient({ startStream: async () => stream }));

  try {
    const events = await collect(runtime.turns.start('use a tool'));
    const toolStarts = events.filter((event) => event.type === 'tool_started');
    expect(toolStarts).toHaveLength(1);
    expect(toolStarts[0]).toMatchObject({ toolCallId: 'tool-1', toolName: 'shell' });
  } finally {
    await runtime.shutdown();
  }
});

it('delegates public-seam steer, retract, and edit operations while an approval is parked', async () => {
  const steerCalls: unknown[] = [];
  const retractCalls: string[] = [];
  const editCalls: unknown[] = [];
  const runtime = runtimeFor(
    'public-steer',
    createMockAgentClient({
      startStream: async () => interruptedStream({ callId: 'steer-approval' }),
      continueRunStream: async () => finalStream('steered'),
      steer: async (items: unknown, options: unknown) => {
        steerCalls.push({ items, options });
        return 'released';
      },
      retractSteer: (id: string) => {
        retractCalls.push(id);
        return true;
      },
      editSteer: (id: string, items: unknown) => {
        editCalls.push({ id, items });
        return true;
      },
    }),
  );

  try {
    await collect(runtime.turns.start('park'));
    await expect(runtime.turns.steer([{ role: 'user', content: 'discard' }] as never, { id: 's1' })).resolves.toBe(
      'released',
    );
    expect(runtime.turns.retractSteer('s1')).toBe(true);
    await expect(runtime.turns.steer([{ role: 'user', content: 'keep' }] as never, { id: 's2' })).resolves.toBe(
      'released',
    );
    expect(runtime.turns.editSteer('s2', [{ role: 'user', content: 'edited' }] as never)).toBe(true);
    await collect(runtime.turns.continueAfterApproval({ answer: 'y' }));
    expect(steerCalls).toHaveLength(2);
    expect(retractCalls).toEqual(['s1']);
    expect(editCalls).toEqual([{ id: 's2', items: [{ role: 'user', content: 'edited' }] }]);
  } finally {
    await runtime.shutdown();
  }
});

it('exports and imports state through separate public runtimes without an early provider call', async () => {
  const source = runtimeFor(
    'public-export-source',
    createMockAgentClient({ startStream: async () => finalStream('saved') }),
  );
  const calls: unknown[] = [];
  const target = runtimeFor(
    'public-export-target',
    createMockAgentClient({
      startStream: async (...args: unknown[]) => {
        calls.push(args);
        return finalStream('unexpected');
      },
    }),
  );

  try {
    await collect(source.turns.start('save this'));
    const exported = source.state.exportState();
    target.state.importState(exported);
    expect(calls).toEqual([]);
    expect(target.state.getCurrentSnapshot().history).toEqual(source.state.getCurrentSnapshot().history);
  } finally {
    await source.shutdown();
    await target.shutdown();
  }
});

it('replays imported history through the public seam with a fresh full-history request', async () => {
  const calls: Array<{ input: unknown; options: unknown }> = [];
  const runtime = runtimeFor(
    'public-replay',
    createMockAgentClient({
      getProvider: () => 'openai',
      startStream: async (input: unknown, options: unknown) => {
        calls.push({ input, options });
        return finalStream('resumed');
      },
    }),
  );

  try {
    runtime.state.importState({
      history: [
        { role: 'user', type: 'message', content: 'earlier' },
        {
          role: 'assistant',
          type: 'message',
          status: 'completed',
          content: [{ type: 'output_text', text: 'earlier answer' }],
        },
      ],
      previousResponseId: 'stale-response',
      toolLedger: [],
    });
    await collect(runtime.turns.start('follow-up'));

    expect(calls).toHaveLength(1);
    expect(Array.isArray(calls[0].input)).toBe(true);
    expect(calls[0].input).toEqual([
      { role: 'user', type: 'message', content: 'earlier' },
      {
        role: 'assistant',
        type: 'message',
        status: 'completed',
        content: [{ type: 'output_text', text: 'earlier answer' }],
      },
      { role: 'user', type: 'message', content: 'follow-up' },
    ]);
    expect((calls[0].options as Record<string, unknown>).previousResponseId).toBeFalsy();
  } finally {
    await runtime.shutdown();
  }
});

it('makes public runtime shutdown and dispose idempotent', async () => {
  let subagentDisposals = 0;
  let shellDisposals = 0;
  const runtime = runtimeFor(
    'public-shutdown',
    createMockAgentClient({
      disposeBackgroundSubagents: async () => {
        subagentDisposals += 1;
      },
      disposeBackgroundShellJobs: async () => {
        shellDisposals += 1;
      },
    }),
  );

  await Promise.all([runtime.shutdown(), runtime.shutdown()]);
  runtime.dispose();
  runtime.dispose();
  expect(subagentDisposals).toBe(1);
  expect(shellDisposals).toBe(1);
});
