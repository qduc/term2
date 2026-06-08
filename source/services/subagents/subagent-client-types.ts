import type { ConversationAgentClient, ShellAutoApprovalAgentClient } from '../conversation-agent-client.js';

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
  }): ConversationAgentClient;
}
