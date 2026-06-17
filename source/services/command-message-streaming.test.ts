import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import {
  attachCachedArguments,
  captureToolCallArguments,
  emitCommandMessagesFromItems,
} from './command-message-streaming.js';

it('captureToolCallArguments: stores args for function_call rawItem', () => {
  const toolCallArgumentsById = new Map<string, unknown>();
  const item = {
    rawItem: {
      type: 'function_call',
      callId: 'call-1',
      arguments: { command: 'ls' },
    },
  };

  captureToolCallArguments(item, toolCallArgumentsById);

  expect(toolCallArgumentsById.get('call-1')).toEqual({ command: 'ls' });
});

it('attachCachedArguments: adds cached args when missing on item', () => {
  const toolCallArgumentsById = new Map<string, unknown>([['call-2', { command: 'pwd' }]]);
  const items: any[] = [
    {
      rawItem: {
        callId: 'call-2',
      },
    },
  ];

  attachCachedArguments(items, toolCallArgumentsById);

  expect(items[0].arguments).toEqual({ command: 'pwd' });
});

it('emitCommandMessagesFromItems: attaches args and filters duplicates/rejections', () => {
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
    expect(passedItems[0].arguments).toEqual({ command: 'whoami' });
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

  expect(events.length).toBe(2);
  expect(events[0].type).toBe('command_message');
  expect((events[0] as any).message.id).toBe('keep');
  expect(events[1].type).toBe('command_message');
  expect((events[1] as any).message.id).toBe('reject');
  expect(emittedCommandIds.has('keep')).toBe(true);
  expect(emittedCommandIds.has('reject')).toBe(true);
});
