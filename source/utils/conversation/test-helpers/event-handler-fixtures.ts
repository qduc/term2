import type { ConversationEventHandlerDeps } from '../conversation-event-handler.js';

export interface MockDeps extends ConversationEventHandlerDeps {
  botResponseUpdater: { push: (text: string) => void; cancel: () => void; flush: () => void };
  reasoningUpdater: { push: (text: string) => void; cancel: () => void; flush: () => void };
  appendMessages: (messages: any[]) => void;
  setMessages: (updater: (prev: any[]) => any[]) => void;
  createMessageId: () => string;
  trimMessages: (messages: any[]) => any[];
  annotateCommandMessage: (msg: any) => any;
}

export function createMockDeps(): MockDeps & {
  calls: {
    botResponsePushes: string[];
    botResponseCancelled: boolean;
    botResponseFlushed: boolean;
    reasoningPushes: string[];
    reasoningFlushed: boolean;
    reasoningCancelled: boolean;
    appendedMessages: any[][];
    setMessagesCalls: Array<(prev: any[]) => any[]>;
  };
} {
  const calls = {
    botResponsePushes: [] as string[],
    botResponseCancelled: false,
    botResponseFlushed: false,
    reasoningPushes: [] as string[],
    reasoningFlushed: false,
    reasoningCancelled: false,
    appendedMessages: [] as any[][],
    setMessagesCalls: [] as Array<(prev: any[]) => any[]>,
  };

  return {
    calls,
    createMessageId: (() => {
      let seq = 0;
      return () => `msg-${seq++}`;
    })(),
    botResponseUpdater: {
      push: (text: string) => calls.botResponsePushes.push(text),
      cancel: () => {
        calls.botResponseCancelled = true;
      },
      flush: () => {
        calls.botResponseFlushed = true;
      },
    },
    reasoningUpdater: {
      push: (text: string) => calls.reasoningPushes.push(text),
      cancel: () => {
        calls.reasoningCancelled = true;
      },
      flush: () => {
        calls.reasoningFlushed = true;
      },
    },
    appendMessages: (messages: any[]) => calls.appendedMessages.push(messages),
    setMessages: (updater: (prev: any[]) => any[]) => calls.setMessagesCalls.push(updater),
    trimMessages: (messages: any[]) => messages,
    annotateCommandMessage: (msg: any) => ({ ...msg, annotated: true }),
  };
}
