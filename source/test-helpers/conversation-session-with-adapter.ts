import {
  createConversationSessionComposition,
  type CreateConversationSessionOptions,
  type ConversationSessionComposition,
} from '../services/session/session-composition.js';
import { createConversationAdapterForComposition } from '../services/conversation/conversation-adapter-factory.js';
import type { ConversationAdapter } from '../services/conversation/conversation-adapter.js';

export type ConversationSessionWithAdapter = ConversationSessionComposition & {
  terminalAdapter: ConversationAdapter;
};

export function createConversationSession(options: CreateConversationSessionOptions): ConversationSessionWithAdapter {
  const composition = createConversationSessionComposition(options);
  return {
    ...composition,
    terminalAdapter: createConversationAdapterForComposition(composition, { deps: options.deps }),
  };
}
