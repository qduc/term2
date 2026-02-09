import test from 'ava';
import {
  attachCachedArguments,
  captureToolCallArguments,
  emitCommandMessagesFromItems,
} from './command-message-streaming.js';

test('captureToolCallArguments: stores args for function_call rawItem', (t) => {
  const toolCallArgumentsById = new Map<string, unknown>();
  const item = {
    rawItem: {
      type: 'function_call',
      callId: 'call-1',
      arguments: { command: 'ls' },
    },
  };

  captureToolCallArguments(item, toolCallArgumentsById);

  t.deepEqual(toolCallArgumentsById.get('call-1'), { command: 'ls' });
});

test('attachCachedArguments: adds cached args when missing on item', (t) => {
  const toolCallArgumentsById = new Map<string, unknown>([['call-2', { command: 'pwd' }]]);
  const items: any[] = [
    {
      rawItem: {
        callId: 'call-2',
      },
    },
  ];

  attachCachedArguments(items, toolCallArgumentsById);

  t.deepEqual(items[0].arguments, { command: 'pwd' });
});

test('emitCommandMessagesFromItems: attaches args and filters duplicates/rejections', (t) => {
  const toolCallArgumentsById = new Map<string, unknown>([['call-3', { command: 'whoami' }]]);
  const emittedCommandIds = new Set<string>(['dupe']);
  const items: any[] = [
    {
      rawItem: {
        callId: 'call-3',
      },
    },
  ];

  const extractCommandMessages = (passedItems: any[]) => {
    t.deepEqual(passedItems[0].arguments, { command: 'whoami' });
    return [
      {
        id: 'dupe',
        sender: 'command' as const,
        status: 'completed' as const,
        command: 'dupe',
        output: '',
        success: true,
      },
      {
        id: 'keep',
        sender: 'command' as const,
        status: 'completed' as const,
        command: 'keep',
        output: '',
        success: true,
      },
      {
        id: 'reject',
        sender: 'command' as const,
        status: 'completed' as const,
        command: 'reject',
        output: '',
        success: true,
        isApprovalRejection: true,
      },
    ];
  };

  const events = emitCommandMessagesFromItems(items, {
    toolCallArgumentsById,
    emittedCommandIds,
    extractCommandMessages,
  });

  t.is(events.length, 1);
  t.is(events[0].type, 'command_message');
  t.is((events[0] as any).message.id, 'keep');
  t.true(emittedCommandIds.has('keep'));
  t.false(emittedCommandIds.has('reject'));
});
