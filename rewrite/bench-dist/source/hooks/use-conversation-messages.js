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
import { appendMessagesCapped } from '../utils/conversation/message-buffer.js';
import { getUserMessageEntries } from '../utils/conversation/message-utils.js';
import { createMessageId } from './message-id.js';
const DEFAULT_MAX_MESSAGE_COUNT = 300;
export function useConversationMessages({ initialMessages = [], maxMessageCount = DEFAULT_MAX_MESSAGE_COUNT, } = {}) {
    const [messages, setMessages] = useState(() => appendMessagesCapped([], initialMessages, maxMessageCount));
    const trimMessages = useCallback((list) => appendMessagesCapped(list, [], maxMessageCount), [maxMessageCount]);
    const appendMessages = useCallback((additions) => {
        if (!additions.length)
            return;
        setMessages((prev) => appendMessagesCapped([...prev, ...additions], [], maxMessageCount));
    }, [maxMessageCount]);
    const addSystemMessage = useCallback((text, conciseText) => {
        appendMessages([
            {
                id: createMessageId(),
                sender: 'system',
                text,
                ...(conciseText !== undefined ? { conciseText } : {}),
            },
        ]);
    }, [appendMessages]);
    const addDividerMessage = useCallback(() => {
        appendMessages([
            {
                id: createMessageId(),
                sender: 'system',
                text: '',
                presentation: 'rule',
            },
        ]);
    }, [appendMessages]);
    const addShellMessage = useCallback((command, output, exitCode, timedOut) => {
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
            },
        ]);
    }, [appendMessages]);
    const getUserMessages = useCallback(() => {
        return getUserMessageEntries(messages);
    }, [messages]);
    return {
        messages,
        setMessages,
        trimMessages,
        appendMessages,
        addSystemMessage,
        addDividerMessage,
        addShellMessage,
        getUserMessages,
    };
}
//# sourceMappingURL=use-conversation-messages.js.map