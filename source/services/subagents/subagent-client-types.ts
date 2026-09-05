import type { ConversationAgentClient, ShellAutoApprovalAgentClient } from '../conversation-agent-client.js';
import type { ToolApprovalPolicyRegistry } from '../approval/tool-approval-policy-registry.js';

/**
 * Narrow interface SubagentManager needs from the agent client.
 * Breaks the circular import between SubagentManager and OpenAIAgentClient.
 */
export type ISubagentClient = ShellAutoApprovalAgentClient;

/**
 * Factory for creating subagent client instances.
 * The concrete implementation is supplied by OpenAIAgentClient, but callers
 * only expose the ConversationSession-facing surface here.
 */
export interface ISubagentClientFactory {
  createClient(opts: {
    agent: any;
    provider: string;
    maxTurns: number;
    retryAttempts?: number;
    agentId?: string;
    role?: string;
    /**
     * Graph-owned policy authority built alongside the subagent tools.
     * The transient client exposes it so session composition resolves the
     * subagent graph's policies instead of an empty registry.
     */
    approvalPolicyRegistry?: ToolApprovalPolicyRegistry;
  }): ConversationAgentClient;
}
