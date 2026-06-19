import { describe, expect, it } from 'vitest';
import type { Message } from './types/message.js';
import {
  appendStartupBannerId,
  clearTerminalForRedraw,
  estimateLastTurnTokens,
  messagesHaveNonSystemContent,
  TERMINAL_REDRAW_CLEAR,
  scheduleExitSideEffects,
} from './app-helpers.js';

describe('estimateLastTurnTokens', () => {
  it('estimates text input from serialized bytes', () => {
    expect(estimateLastTurnTokens({ text: '12345678' })).toBe(3);
  });

  it('includes image payloads when estimating multimodal turns', () => {
    expect(
      estimateLastTurnTokens({
        text: 'look',
        images: [{ id: 'image-1', data: 'abcd', mimeType: 'image/png', byteSize: 4, displayNumber: 1 }],
      }),
    ).toBeGreaterThan(estimateLastTurnTokens({ text: 'look' }));
  });
});

describe('appendStartupBannerId', () => {
  it('appends a stable id for each banner refresh', () => {
    expect(appendStartupBannerId(['startup-banner-0'])).toEqual(['startup-banner-0', 'startup-banner-1']);
    expect(appendStartupBannerId(['startup-banner-0', 'startup-banner-1'])).toEqual([
      'startup-banner-0',
      'startup-banner-1',
      'startup-banner-2',
    ]);
  });
});

describe('messagesHaveNonSystemContent', () => {
  it('returns false for empty and system-only conversations', () => {
    const messages: Message[] = [];
    expect(messagesHaveNonSystemContent(messages)).toBe(false);
    expect(messagesHaveNonSystemContent([{ id: 'system-message', sender: 'system', text: 'Welcome' }])).toBe(false);
  });

  it('returns true when a non-system message is present', () => {
    expect(messagesHaveNonSystemContent([{ id: 'user-message', sender: 'user', text: 'hello' }])).toBe(true);
    expect(messagesHaveNonSystemContent([{ id: 'assistant-message', sender: 'bot', text: 'hello' }])).toBe(true);
  });
});

describe('clearTerminalForRedraw', () => {
  it('writes the clear sequence once', () => {
    const writes: string[] = [];

    clearTerminalForRedraw({
      write: (value) => {
        writes.push(value);
        return true;
      },
    });

    expect(writes).toEqual([TERMINAL_REDRAW_CLEAR]);
  });
});

describe('scheduleExitSideEffects', () => {
  it('schedules the exit usage callback on the next turn', () => {
    const events: string[] = [];
    const scheduled: Array<() => void> = [];

    scheduleExitSideEffects(
      [{ id: 'user-message', sender: 'user', text: 'hello' }],
      () => {
        events.push('usage');
      },
      (callback) => {
        scheduled.push(callback);
        events.push('scheduled');
      },
    );

    expect(events).toEqual(['scheduled']);
    scheduled[0]!();
    expect(events).toEqual(['scheduled', 'usage']);
  });
});
