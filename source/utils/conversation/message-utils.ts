import type { CommandMessage } from '../../tools/types.js';
import type { Message } from '../../types/message.js';
import { isCommandMessage, isUserMessage } from '../../types/message.js';

/**
 * Get the text content of the final assistant response, combining contiguous
 * bot messages into a single string. Returns null if no bot messages exist.
 */
export function getLastFinalAssistantText(messages: Message[]): string | null {
  let lastBotIndex = -1;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.sender === 'bot' && typeof message.text === 'string' && message.text.length > 0) {
      lastBotIndex = index;
      break;
    }
  }

  if (lastBotIndex === -1) {
    return null;
  }

  const texts: string[] = [];
  for (let index = lastBotIndex; index >= 0; index--) {
    const message = messages[index];
    if (message?.sender === 'bot') {
      if (typeof message.text === 'string') {
        texts.unshift(message.text);
      }
    } else {
      break;
    }
  }

  return texts.join('').trim() || null;
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
 * Find the index of the last user message that was not consumed for abort.
 * Returns -1 if no undoable user message exists.
 */
export function findLastUndoableUserMessage(messages: Message[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (isUserMessage(m) && !m.consumedForAbort) {
      return i;
    }
  }
  return -1;
}

/**
 * Count how many undoable user turns exist at or after startIndex.
 */
export function countUndoableUserTurnsFrom(messages: Message[], startIndex: number): number {
  let count = 0;
  for (let i = startIndex; i < messages.length; i++) {
    const m = messages[i];
    if (isUserMessage(m) && !m.consumedForAbort) {
      count++;
    }
  }
  return count;
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
