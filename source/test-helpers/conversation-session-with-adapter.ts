import {
  createSessionRuntimeInternals,
  buildSessionRuntime,
  type CreateConversationSessionOptions,
  type SessionRuntimeInternals,
} from '../services/session/session-composition.js';
import { createConversationAdapterForRuntime } from '../services/conversation/conversation-adapter-factory.js';
import type { ConversationAdapter } from '../services/conversation/conversation-adapter.js';

export type ConversationSessionWithAdapter = SessionRuntimeInternals & {
  terminalAdapter: ConversationAdapter;
};

export function createConversationSession(options: CreateConversationSessionOptions): ConversationSessionWithAdapter {
  const internals = createSessionRuntimeInternals(options);
  const runtime = buildSessionRuntime(internals);
  return {
    ...internals,
    terminalAdapter: createConversationAdapterForRuntime(runtime, { deps: options.deps }),
  };
}
