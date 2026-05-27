import type { Message } from '../hooks/use-conversation.js';

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
