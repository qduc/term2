import test from 'ava';
import { collectTerminalResult } from './terminal-result-collector.js';

const asAsyncIterable = async function* (events: any[]) {
  for (const event of events) {
    yield event;
  }
};

test('collectTerminalResult returns approval_required with raw interruption from callback', async (t) => {
  const seenEvents: string[] = [];
  const textChunks: string[] = [];

  const result = await collectTerminalResult(
    asAsyncIterable([
      { type: 'text_delta', delta: 'Hello', fullText: 'Hello' },
      {
        type: 'approval_required',
        approval: {
          agentName: 'CLI Agent',
          toolName: 'shell',
          argumentsText: 'ls source',
          callId: 'call-approval',
        },
      },
    ]),
    {
      onEvent: (event) => seenEvents.push(event.type),
      onTextChunk: (full, chunk) => textChunks.push(`${full}:${chunk}`),
      getRawInterruption: () => ({ id: 'raw-interruption' }),
    },
  );

  t.deepEqual(seenEvents, ['text_delta', 'approval_required']);
  t.deepEqual(textChunks, ['Hello:Hello']);
  t.is(result.type, 'approval_required');
  if (result.type === 'approval_required') {
    t.is(result.approval.callId, 'call-approval');
    t.deepEqual(result.approval.rawInterruption, { id: 'raw-interruption' });
  }
});

test('collectTerminalResult preserves usage on approval_required', async (t) => {
  const result = await collectTerminalResult(
    asAsyncIterable([
      {
        type: 'final',
        finalText: '',
        usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
      },
      {
        type: 'approval_required',
        usage: { prompt_tokens: 120, completion_tokens: 12, total_tokens: 132 },
        approval: {
          agentName: 'CLI Agent',
          toolName: 'shell',
          argumentsText: 'ls source',
        },
      },
    ]),
  );

  t.is(result.type, 'approval_required');
  if (result.type === 'approval_required') {
    t.deepEqual(result.usage, { prompt_tokens: 120, completion_tokens: 12, total_tokens: 132 });
  }
});

test('collectTerminalResult carries usage_update usage into approval_required result', async (t) => {
  const result = await collectTerminalResult(
    asAsyncIterable([
      {
        type: 'usage_update',
        usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
      },
      {
        type: 'approval_required',
        approval: {
          agentName: 'CLI Agent',
          toolName: 'shell',
          argumentsText: 'ls source',
        },
      },
    ]),
  );

  t.is(result.type, 'approval_required');
  if (result.type === 'approval_required') {
    t.deepEqual(result.usage, { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 });
  }
});

test('collectTerminalResult trusts the final run-cumulative usage and does not re-sum per-turn snapshots', async (t) => {
  // Long-horizon regression: a multi-turn run streams a per-turn `usage_update`
  // before each tool call. The terminal `final` event carries the authoritative
  // run-cumulative usage from the SDK. The collector must report that cumulative
  // verbatim - NOT the cumulative plus its own re-summed per-turn snapshots
  // (the old behavior, which doubled the count and got worse with each turn).
  const result = await collectTerminalResult(
    asAsyncIterable([
      { type: 'usage_update', usage: { prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1050 } },
      { type: 'tool_started', toolCallId: 'call-1', toolName: 'shell', arguments: { command: 'ls' } },
      { type: 'usage_update', usage: { prompt_tokens: 2000, completion_tokens: 90, total_tokens: 2090 } },
      { type: 'tool_started', toolCallId: 'call-2', toolName: 'shell', arguments: { command: 'cat a' } },
      { type: 'usage_update', usage: { prompt_tokens: 3000, completion_tokens: 120, total_tokens: 3120 } },
      { type: 'tool_started', toolCallId: 'call-3', toolName: 'shell', arguments: { command: 'cat b' } },
      {
        type: 'final',
        finalText: 'Done.',
        // SDK run-state accumulator: cumulative across all turns, including
        // cache details streamed snapshots didn't carry.
        usage: {
          prompt_tokens: 6000,
          completion_tokens: 280,
          total_tokens: 6280,
          cache_read_tokens: 1500,
        },
      },
    ]),
  );

  t.is(result.type, 'response');
  if (result.type === 'response') {
    t.deepEqual(result.usage, {
      prompt_tokens: 6000,
      completion_tokens: 280,
      total_tokens: 6280,
      cache_read_tokens: 1500,
    });
  }
});

test('collectTerminalResult lets a later final supersede an earlier one (auto-approved continuation)', async (t) => {
  // The auto-approve path emits a `final` for the first turn, then another
  // `final` after the continuation. Because the SDK accumulator keeps growing
  // on the same run state, the later `final` is the whole-run cumulative and
  // must replace - not add to - the earlier one.
  const result = await collectTerminalResult(
    asAsyncIterable([
      { type: 'final', finalText: 'partial', usage: { prompt_tokens: 200, completion_tokens: 20, total_tokens: 220 } },
      { type: 'final', finalText: 'Done.', usage: { prompt_tokens: 500, completion_tokens: 60, total_tokens: 560 } },
    ]),
  );

  t.is(result.type, 'response');
  if (result.type === 'response') {
    t.deepEqual(result.usage, { prompt_tokens: 500, completion_tokens: 60, total_tokens: 560 });
  }
});

test('collectTerminalResult falls back to the latest streamed usage when no final usage is present', async (t) => {
  const result = await collectTerminalResult(
    asAsyncIterable([
      { type: 'usage_update', usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } },
      { type: 'usage_update', usage: { prompt_tokens: 175, completion_tokens: 18, total_tokens: 193 } },
      { type: 'final', finalText: 'Done.' },
    ]),
  );

  t.is(result.type, 'response');
  if (result.type === 'response') {
    t.deepEqual(result.usage, { prompt_tokens: 175, completion_tokens: 18, total_tokens: 193 });
  }
});

test('collectTerminalResult accumulates streamed callbacks and returns final response payload', async (t) => {
  const seenText: string[] = [];
  const seenReasoning: string[] = [];
  const seenCommands: string[] = [];
  const seenEvents: string[] = [];
  let sawFinal = false;

  const result = await collectTerminalResult(
    asAsyncIterable([
      { type: 'text_delta', delta: 'Hello', fullText: 'Hello' },
      { type: 'reasoning_delta', delta: 'Think', fullText: 'Think' },
      {
        type: 'command_message',
        message: {
          id: 'cmd-1',
          sender: 'command',
          status: 'completed',
          command: 'ls source',
          output: 'source',
          success: true,
        },
      },
      {
        type: 'final',
        finalText: 'Done.',
        reasoningText: 'Finished reasoning',
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
        commandMessages: [
          {
            id: 'cmd-2',
            sender: 'command',
            status: 'completed',
            command: 'pwd',
            output: '/tmp',
            success: true,
          },
        ],
      },
    ]),
    {
      onTextChunk: (full, chunk) => seenText.push(`${full}:${chunk}`),
      onReasoningChunk: (full, chunk) => seenReasoning.push(`${full}:${chunk}`),
      onCommandMessage: (message) => seenCommands.push(message.id),
      onEvent: (event) => seenEvents.push(event.type),
      onFinalEvent: () => {
        sawFinal = true;
      },
    },
  );

  t.true(sawFinal);
  t.deepEqual(seenText, ['Hello:Hello']);
  t.deepEqual(seenReasoning, ['Think:Think']);
  t.deepEqual(seenCommands, ['cmd-1']);
  t.deepEqual(seenEvents, ['text_delta', 'reasoning_delta', 'command_message', 'final']);

  t.is(result.type, 'response');
  if (result.type === 'response') {
    t.is(result.finalText, 'Done.');
    t.is(result.reasoningText, 'Finished reasoning');
    t.deepEqual(result.usage, { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 });
    t.deepEqual(
      result.commandMessages.map((m) => m.id),
      ['cmd-2'],
    );
  }
});
