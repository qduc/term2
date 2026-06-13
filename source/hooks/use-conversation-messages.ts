/**
 * Sub-hook for conversation message list operations.
 *
 * Owns the `messages` state and provides pure message-list operations:
 * append, add system/shell messages, list user messages, and trim.
 *
 * The root hook (`useConversation`) keeps orchestration responsibilities
 * (send, approval, streaming, undo) and only uses `setMessages` from here.
 */

import { useCallback, useState } from 'react';
import type { Message, CommandMessage } from '../types/message.js';
import { appendMessagesCapped } from '../utils/conversation/message-buffer.js';
import { getUserMessageEntries } from '../utils/conversation/message-utils.js';
import { createMessageId } from './message-id.js';

export interface UseConversationMessagesParams {
  initialMessages?: Message[];
  maxMessageCount?: number;
}

const DEFAULT_MAX_MESSAGE_COUNT = 300;

export function useConversationMessages({
  initialMessages = [],
  maxMessageCount = DEFAULT_MAX_MESSAGE_COUNT,
}: UseConversationMessagesParams = {}) {
  const [messages, setMessages] = useState<Message[]>(() => appendMessagesCapped([], initialMessages, maxMessageCount));

  const trimMessages = useCallback(
    (list: Message[]) => appendMessagesCapped(list, [], maxMessageCount),
    [maxMessageCount],
  );

  const appendMessages = useCallback(
    (additions: Message[]) => {
      if (!additions.length) return;
      setMessages((prev) => appendMessagesCapped([...prev, ...additions], [], maxMessageCount));
    },
    [maxMessageCount],
  );

  const addSystemMessage = useCallback(
    (text: string) => {
      appendMessages([
        {
          id: createMessageId(),
          sender: 'system',
          text,
        },
      ]);
    },
    [appendMessages],
  );

  const addShellMessage = useCallback(
    (command: string, output: string, exitCode: number | null, timedOut: boolean) => {
      const success = !timedOut && exitCode === 0;
      const failureReason = timedOut
        ? 'timeout'
        : exitCode == null
        ? 'error'
        : exitCode !== 0
        ? `exit ${exitCode}`
        : undefined;

      appendMessages([
        {
          id: createMessageId(),
          sender: 'command',
          status: success ? 'completed' : 'failed',
          command,
          output,
          success,
          failureReason,
          toolName: 'shell',
        } as CommandMessage,
      ]);
    },
    [appendMessages],
  );

  const getUserMessages = useCallback((): { uiIndex: number; text: string }[] => {
    return getUserMessageEntries(messages);
  }, [messages]);

  return {
    messages,
    setMessages,
    trimMessages,
    appendMessages,
    addSystemMessage,
    addShellMessage,
    getUserMessages,
  };
}
