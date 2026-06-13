/**
 * Pure helper that applies a {@link ConversationTerminal} result to a messages
 * list. Extracted from `use-conversation.ts` so it can be unit tested.
 *
 * The non-trivial branch handles text duplication. The streaming event handler
 * pushes a `status: 'streaming'` bot message into the UI as `text_delta`
 * events arrive. The terminal result also carries `finalText`, which is the
 * authoritative accumulated output. When the streaming tail never crosses a
 * safe markdown boundary, the live bot message remains in the list with its
 * streamed text; appending a second finalized message with the same text
 * would render the assistant's reply twice (once bold/streaming, once again
 * with the raw markdown asterisks intact, see the reproduction in the
 * "duplicate bot text" test). We finalize the streaming message in place
 * instead.
 *
 * The function never mutates the input `prev` array. It returns a fresh array
 * (possibly equal to `prev` when nothing changed) so the caller can rely on
 * React's referential equality to skip re-renders.
 */

import type { ConversationTerminal } from '../../contracts/conversation.js';
import type { BotMessage, CommandMessage, Message } from '../../types/message.js';
import type { StreamingState } from './conversation-utils.js';
import { mergeCommandMessages } from './message-utils.js';

export interface ApplyConversationResultOptions {
  result: ConversationTerminal;
  streamingState: StreamingState;
  createMessageId: () => string;
  trimMessages: (messages: Message[]) => Message[];
  annotateCommandMessage: (msg: CommandMessage) => CommandMessage;
}

export const isStreamingBotMessageId = (
  streamingState: Pick<StreamingState, 'currentBotMessageId'>,
  messages: Message[],
): string | null => {
  if (streamingState.currentBotMessageId === null) {
    return null;
  }
  const id = streamingState.currentBotMessageId;
  return messages.some((m) => m.id === id && m.sender === 'bot') ? id : null;
};

const finalizeStreamingBotMessage = (messages: Message[], botMessageId: string, finalText: string): Message[] => {
  const index = messages.findIndex((m) => m.id === botMessageId);
  if (index === -1) {
    return messages;
  }
  const current = messages[index];
  if (current.sender !== 'bot') {
    return messages;
  }
  const next = messages.slice();
  const updated: BotMessage = { ...current, status: 'finalized', text: finalText };
  next[index] = updated;
  return next;
};

const appendFinalizedBotMessage = (
  messages: Message[],
  finalText: string,
  createMessageId: () => string,
): Message[] => {
  const botMessage: BotMessage = {
    id: createMessageId(),
    sender: 'bot',
    status: 'finalized',
    text: finalText,
  };
  return [...messages, botMessage];
};

export interface ApplyResponseResult {
  /** The next message list, equal to `prev` when nothing changed. */
  next: Message[];
  /** True when the live streaming bot message was promoted to finalized. */
  finalizedStreamingMessage: boolean;
}

/**
 * Pure function: given the previous messages and a terminal response result,
 * compute the next messages list. When a live streaming bot message exists it
 * is finalized in place; otherwise the final text is appended as a new
 * finalized message (sync provider path).
 *
 * The caller is responsible for clearing the streaming state's bookkeeping
 * (e.g. `currentBotMessageId`) when `finalizedStreamingMessage` is true.
 */
export const computeNextMessages = ({
  prev,
  result,
  streamingState,
  createMessageId,
  trimMessages,
  annotateCommandMessage,
}: ApplyConversationResultOptions & { prev: Message[] }): ApplyResponseResult => {
  if (result.type !== 'response') {
    return { next: prev, finalizedStreamingMessage: false };
  }

  const annotatedCommands = result.commandMessages.map(annotateCommandMessage);
  const merged = mergeCommandMessages(prev, annotatedCommands);

  const finalText = result.finalText;
  if (!finalText || !finalText.trim()) {
    return { next: trimMessages(merged), finalizedStreamingMessage: false };
  }

  const liveBotMessageId = isStreamingBotMessageId(streamingState, merged);
  if (liveBotMessageId !== null) {
    // The streaming message represents only the un-flushed tail of the
    // streamed output. Earlier text that crossed a safe boundary was already
    // promoted to a finalized message, so the tail should be the slice of
    // `finalText` from `flushedTextLength` onward, not the full text.
    const tailText = finalText.slice(streamingState.flushedTextLength);
    const finalized = finalizeStreamingBotMessage(merged, liveBotMessageId, tailText);
    return { next: trimMessages(finalized), finalizedStreamingMessage: true };
  }

  // No live streaming message exists. `textWasFlushed` is the streaming event
  // handler's boundary-detection flag; when true, some earlier text was
  // already promoted to a finalized message, so `finalText` is the tail that
  // is already represented in the live stream and must not be appended again.
  if (streamingState.textWasFlushed) {
    return { next: trimMessages(merged), finalizedStreamingMessage: false };
  }

  return {
    next: trimMessages(appendFinalizedBotMessage(merged, finalText, createMessageId)),
    finalizedStreamingMessage: false,
  };
};

/**
 * Clears the streaming state bookkeeping once a live bot message has been
 * promoted to finalized by {@link computeNextMessages}. Idempotent; safe to
 * call when no live message exists.
 */
export const clearStreamingBotMessage = (streamingState: StreamingState): void => {
  streamingState.currentBotMessageId = null;
  streamingState.accumulatedText = '';
  streamingState.flushedTextLength = 0;
  streamingState.textWasFlushed = true;
};
