import type { Message } from './types/message.js';
import type { UserTurn } from './types/user-turn.js';
import { getSerializedInputBytes } from './services/large-uncached-input-guard.js';
import type { TerminalWriter } from './types/terminal.js';

export const estimateLastTurnTokens = (turn: UserTurn): number => {
  const images = turn.images ?? [];
  let inputItem: unknown;
  if (images.length === 0) {
    inputItem = turn.text ?? '';
  } else {
    const content: any[] = [];
    if (turn.text) {
      content.push({ type: 'input_text', text: turn.text });
    }
    for (const image of images) {
      content.push({
        type: 'input_image',
        image: `data:${image.mimeType};base64,${image.data}`,
        detail: 'auto',
      });
    }
    inputItem = { role: 'user', type: 'message', content };
  }
  const bytes = getSerializedInputBytes(inputItem);
  return Math.ceil(bytes / 4);
};

export const appendStartupBannerId = (ids: string[]): string[] => [...ids, `startup-banner-${ids.length}`];

export const messagesHaveNonSystemContent = (messages: Message[]): boolean =>
  messages.some((msg) => msg.sender !== 'system');

export const TERMINAL_REDRAW_CLEAR = '\u001B[2J\u001B[3J\u001B[H';

export const clearTerminalForRedraw = (stdout: TerminalWriter): void => {
  stdout.write(TERMINAL_REDRAW_CLEAR);
};

type ScheduleCallback = (callback: () => void, delay: number) => unknown;

export const scheduleExitSideEffects = (
  _messages: Message[],
  onExitUsage?: () => void,
  schedule: ScheduleCallback = setTimeout,
): void => {
  schedule(() => {
    onExitUsage?.();
  }, 0);
};
