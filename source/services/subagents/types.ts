import type { NormalizedUsage } from '../../utils/ai/token-usage.js';

export const SUBAGENT_ROLES = ['explorer', 'worker', 'researcher', 'mentor'] as const;
export type SupportedSubagentRole = (typeof SUBAGENT_ROLES)[number];
export type SubagentRole = SupportedSubagentRole | string;

export interface SubagentRequest {
  role: SubagentRole;
  task: string;
  /** Parent tool/run cancellation signal. */
  signal?: AbortSignal;
  /** SDK serialized run state for resuming a delegated agent-tool run (nested approvals). */
  resumeState?: string;
  /** Name of the tool that invoked the subagent, if any. */
  parentTool?: string;
}

export interface SubagentDefinition {
  role: SubagentRole;
  name: string;
  instructions: string;
  canRead: boolean;
  canWrite: boolean;
  canSearchWeb: boolean;
  canRunShell: boolean;
  maxTurns: number;
  model: string;
  provider: string;
  reasoningEffort: string;
  description?: string;
}

export interface SubagentResult {
  agentId: string;
  role: string;
  status: 'completed' | 'failed' | 'cancelled';
  finalText: string;
  filesChanged: string[];
  toolsUsed: Array<{
    toolName: string;
    count: number;
  }>;
  usage?: NormalizedUsage;
  error?: string;
  /** SDK nested run result used to propagate/resume delegated approvals. */
  nestedRunResult?: unknown;
}
