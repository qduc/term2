import type { ReasoningEffortSetting } from '../tools/conversation.js';
import type { JsonSchemaDefinition } from '../shared/contracts/model-types.js';
import type { NormalizedUsage } from '../shared/utils/ai/token-usage.js';
import type { ModelRequestCost } from '../shared/cost/model-cost.js';

export type AgentClientChatOptions = {
  model?: string;
  provider?: string;
  reasoningEffort?: ReasoningEffortSetting | null;
  instructions?: string;
  maxTokens?: number;
  signal?: AbortSignal;
};

export type AgentClientChatResult = {
  text: string;
  usage?: NormalizedUsage;
  costRecords?: ModelRequestCost[];
};

export type AgentClientChatJsonOptions = AgentClientChatOptions & {
  outputType: JsonSchemaDefinition;
};

export interface ShellAutoApprovalAgentClient {
  chat(message: string, options?: AgentClientChatOptions): Promise<string>;
  chatDetailed?(message: string, options?: AgentClientChatOptions): Promise<AgentClientChatResult>;
  chatJson?(message: string, options: AgentClientChatJsonOptions): Promise<unknown>;
}
