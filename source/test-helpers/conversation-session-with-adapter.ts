import {
  createSessionRuntimeInternals,
  buildSessionRuntime,
  type CreateConversationSessionOptions,
  type SessionRuntimeInternals,
} from '../services/session/session-composition.js';
import { createConversationAdapterForRuntime } from '../services/conversation/conversation-adapter-factory.js';
import type { ConversationAdapter } from '../services/conversation/conversation-adapter.js';
import { ToolOwnershipRegistry } from '../services/approval/tool-ownership-registry.js';
import { ToolApprovalPolicyRegistry } from '../services/approval/tool-approval-policy-registry.js';

export type ConversationSessionWithAdapter = SessionRuntimeInternals & {
  terminalAdapter: ConversationAdapter;
};

export function createConversationSession(
  options: Omit<CreateConversationSessionOptions, 'toolOwnership' | 'approvalPolicyRegistry'>,
): ConversationSessionWithAdapter {
  const internals = createSessionRuntimeInternals({
    ...options,
    toolOwnership: new ToolOwnershipRegistry(),
    approvalPolicyRegistry: new ToolApprovalPolicyRegistry(),
  });
  const runtime = buildSessionRuntime(internals);
  return {
    ...internals,
    terminalAdapter: createConversationAdapterForRuntime(runtime, { deps: options.deps }),
  };
}
