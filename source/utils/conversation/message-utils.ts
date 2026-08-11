import type { CommandMessage } from '../../tools/types.js';
import type { Message } from '../../types/message.js';
import { isCommandMessage, isUserMessage } from '../../types/message.js';

/**
 * Get an assistant response by its 1-based position from newest to oldest.
 * Contiguous bot messages are combined because streaming can represent one
 * response as several UI messages. Returns null when that response does not
 * exist.
 */
export function getAssistantResponseText(messages: Message[], responseNumber = 1): string | null {
  if (!Number.isSafeInteger(responseNumber) || responseNumber < 1) {
    return null;
  }

  let remaining = responseNumber;
  for (let index = messages.length - 1; index >= 0; ) {
    while (index >= 0 && messages[index]?.sender !== 'bot') {
      index--;
    }
    if (index < 0) {
      return null;
    }

    const texts: string[] = [];
    while (index >= 0) {
      const message = messages[index];
      if (message?.sender !== 'bot') {
        break;
      }
      const text = message.text;
      if (typeof text === 'string') {
        texts.unshift(text);
      }
      index--;
    }

    const responseText = texts.join('').trim();
    if (!responseText) {
      continue;
    }

    remaining--;
    if (remaining === 0) {
      return responseText;
    }
  }

  return null;
}

/**
 * Get the text content of the final assistant response.
 */
export function getLastFinalAssistantText(messages: Message[]): string | null {
  return getAssistantResponseText(messages);
}

/**
 * Remove trailing assistant-visible messages so a retry can replace the last
 * assistant response in place.
 */
export function trimTrailingAssistantMessages(messages: Message[]): Message[] {
  let end = messages.length;
  while (end > 0) {
    const message = messages[end - 1];
    if (
      message?.sender === 'command' ||
      message?.sender === 'bot' ||
      message?.sender === 'reasoning' ||
      message?.sender === 'system' ||
      message?.sender === 'subagent'
    ) {
      end--;
      continue;
    }
    break;
  }

  return end === messages.length ? messages : messages.slice(0, end);
}

/**
 * Deduplicate new command messages against existing UI messages and clean up
 * stale running/pending messages that are about to be replaced by completed ones.
 *
 * Two phases:
 * 1. Filter newCommands to exclude any whose callId already appears in prev
 *    (streaming replaces the running message in place, so those are already shown).
 * 2. Remove stale running/pending messages from prev whose callId matches a
 *    completed command in newCommands (e.g. after a denied tool where a "running"
 *    message was shown during streaming but the final result never cleaned it up).
 */
export function mergeCommandMessages(prev: Message[], newCommands: CommandMessage[]): Message[] {
  // Phase 1: collect callIds already shown in the UI
  const existingCommandCallIds = new Set<string>();
  for (const msg of prev) {
    if (isCommandMessage(msg) && msg.callId) {
      existingCommandCallIds.add(msg.callId);
    }
  }
  const deduped = newCommands.filter((msg) => !msg.callId || !existingCommandCallIds.has(msg.callId));

  // Phase 2: remove stale running/pending messages that will be replaced
  const completedCallIds = new Set(deduped.filter((m) => m.callId).map((m) => m.callId));
  if (completedCallIds.size === 0) {
    return [...prev, ...deduped];
  }

  const cleaned = prev.filter((msg) => {
    if (!isCommandMessage(msg)) return true;
    if (msg.status !== 'running' && msg.status !== 'pending') return true;
    return !msg.callId || !completedCallIds.has(msg.callId);
  });
  return [...cleaned, ...deduped];
}

/**
 * List the indices of every user message that was not consumed for abort, in
 * conversation order. Position N in the result is the UI index of user turn
 * N+1, which is how a 1-based rewind turn number resolves to a message index.
 */
export function listUndoableUserMessageIndices(messages: readonly Message[]): number[] {
  const indices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (isUserMessage(m) && !m.consumedForAbort) {
      indices.push(i);
    }
  }
  return indices;
}

/**
 * Find the index of the last user message that was not consumed for abort.
 * Returns -1 if no undoable user message exists.
 */
export function findLastUndoableUserMessage(messages: readonly Message[]): number {
  const indices = listUndoableUserMessageIndices(messages);
  return indices.length > 0 ? indices[indices.length - 1]! : -1;
}

/**
 * Count how many undoable user turns exist at or after startIndex.
 */
export function countUndoableUserTurnsFrom(messages: readonly Message[], startIndex: number): number {
  return listUndoableUserMessageIndices(messages).filter((index) => index >= startIndex).length;
}

/**
 * Return all undoable user messages with their UI indices and text.
 */
export function getUserMessageEntries(messages: Message[]): Array<{ uiIndex: number; text: string }> {
  const result: Array<{ uiIndex: number; text: string }> = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (isUserMessage(m) && !m.consumedForAbort) {
      result.push({ uiIndex: i, text: m.text });
    }
  }
  return result;
}
