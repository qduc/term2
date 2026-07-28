import { it, expect } from 'vitest';
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

it('attachCachedArguments: enriches canonical results without mutating them', () => {
  const toolCallArgumentsById = new Map<string, unknown>([['call-2', { command: 'pwd' }]]);
  const items = [
    {
      type: 'tool_result' as const,
      callId: 'call-2',
      toolName: 'shell',
      status: 'completed' as const,
      output: 'ok',
    },
  ];

  const enriched = attachCachedArguments(items, toolCallArgumentsById);

  expect(enriched[0]?.arguments).toEqual({ command: 'pwd' });
  expect(items[0]).not.toHaveProperty('arguments');
});

it('emitCommandMessagesFromItems: attaches args and filters duplicates/rejections', () => {
  const toolCallArgumentsById = new Map<string, unknown>([['call-3', { command: 'whoami' }]]);
  const emittedCommandIds = new Set<string>(['dupe']);
  const items = [
    {
      type: 'tool_result' as const,
      callId: 'call-3',
      toolName: 'shell',
      status: 'completed' as const,
      output: 'ok',
    },
  ];

  const extractCommandMessages = (passedItems: readonly any[]) => {
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
