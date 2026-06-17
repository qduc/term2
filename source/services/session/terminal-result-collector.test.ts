import { it, expect } from 'vitest';
import { collectTerminalResult } from './terminal-result-collector.js';

const asAsyncIterable = async function* (events: any[]) {
  for (const event of events) {
    yield event;
  }
};

it('collectTerminalResult returns approval_required with raw interruption from callback', async () => {
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

  expect(seenEvents).toEqual(['text_delta', 'approval_required']);
  expect(textChunks).toEqual(['Hello:Hello']);
  expect(result.type).toBe('approval_required');
  if (result.type === 'approval_required') {
    expect(result.approval.callId).toBe('call-approval');
    expect(result.approval.rawInterruption).toEqual({ id: 'raw-interruption' });
  }
});

it('collectTerminalResult preserves usage on approval_required', async () => {
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

  expect(result.type).toBe('approval_required');
  if (result.type === 'approval_required') {
    expect(result.usage).toEqual({ prompt_tokens: 120, completion_tokens: 12, total_tokens: 132 });
  }
});

it('collectTerminalResult carries usage_update usage into approval_required result', async () => {
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

  expect(result.type).toBe('approval_required');
  if (result.type === 'approval_required') {
    expect(result.usage).toEqual({ prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 });
  }
});

it('collectTerminalResult trusts the final run-cumulative usage and does not re-sum per-turn snapshots', async () => {
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

  expect(result.type, 'response');
  if (result.type === 'response') {
    expect(result.usage, {
      prompt_tokens: 6000,
      completion_tokens: 280,
      total_tokens: 6280,
      cache_read_tokens: 1500,
    });
  }
});

it('collectTerminalResult lets a later final supersede an earlier one (auto-approved continuation)', async (t) => {
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

  expect(result.type, 'response');
  if (result.type === 'response') {
    expect(result.usage, { prompt_tokens: 500, completion_tokens: 60, total_tokens: 560 });
  }
});

it('collectTerminalResult falls back to the latest streamed usage when no final usage is present', async (t) => {
  const result = await collectTerminalResult(
    asAsyncIterable([
      { type: 'usage_update', usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } },
      { type: 'usage_update', usage: { prompt_tokens: 175, completion_tokens: 18, total_tokens: 193 } },
      { type: 'final', finalText: 'Done.' },
    ]),
  );

  expect(result.type, 'response');
  if (result.type === 'response') {
    expect(result.usage, { prompt_tokens: 175, completion_tokens: 18, total_tokens: 193 });
  }
});

it('collectTerminalResult accumulates streamed callbacks and returns final response payload', async (t) => {
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

  expect(sawFinal).toBe(true);
  expect(seenText).toEqual(['Hello:Hello']);
  expect(seenReasoning).toEqual(['Think:Think']);
  expect(seenCommands).toEqual(['cmd-1']);
  expect(seenEvents).toEqual(['text_delta', 'reasoning_delta', 'command_message', 'final']);

  expect(result.type).toBe('response');
  if (result.type === 'response') {
    expect(result.finalText).toBe('Done.');
    expect(result.reasoningText).toBe('Finished reasoning');
    expect(result.usage).toEqual({ prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 });
    expect(result.commandMessages.map((m) => m.id)).toEqual(['cmd-2']);
  }
});

it('collectTerminalResult preserves multiple reasoning and text segments in turnItems in order', async () => {
  const result = await collectTerminalResult(
    asAsyncIterable([
      { type: 'reasoning_delta', delta: 'Think 1' },
      { type: 'text_delta', delta: 'Hello' },
      { type: 'reasoning_delta', delta: 'Think 2' },
      { type: 'text_delta', delta: ' World' },
      { type: 'final', finalText: 'Hello World' },
    ]),
  );

  expect(result.type).toBe('response');
  if (result.type === 'response') {
    expect(result.finalText).toBe('Hello World');
    expect(result.turnItems).toEqual([
      { type: 'reasoning', text: 'Think 1' },
      { type: 'assistant_text', text: 'Hello' },
      { type: 'reasoning', text: 'Think 2' },
      { type: 'assistant_text', text: ' World' },
    ]);
  }
});

it('collectTerminalResult trusts event.turnItems if provided on final event', async () => {
  const result = await collectTerminalResult(
    asAsyncIterable([
      { type: 'reasoning_delta', delta: 'Ignored delta' },
      {
        type: 'final',
        finalText: 'Final text',
        turnItems: [
          { type: 'reasoning', text: 'Authoritative reasoning' },
          { type: 'assistant_text', text: 'Authoritative text' },
          { type: 'tool_call', callId: 'call-1', toolName: 'shell', arguments: 'ls' },
          { type: 'tool_result', callId: 'call-1', toolName: 'shell', status: 'completed', output: 'ok' },
        ],
      },
    ]),
  );

  expect(result.type).toBe('response');
  if (result.type === 'response') {
    expect(result.finalText).toBe('Final text');
    expect(result.turnItems).toEqual([
      { type: 'reasoning', text: 'Authoritative reasoning' },
      { type: 'assistant_text', text: 'Authoritative text' },
      { type: 'tool_call', callId: 'call-1', toolName: 'shell', arguments: 'ls' },
      { type: 'tool_result', callId: 'call-1', toolName: 'shell', status: 'completed', output: 'ok' },
    ]);
  }
});
