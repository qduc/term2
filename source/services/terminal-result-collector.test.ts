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
