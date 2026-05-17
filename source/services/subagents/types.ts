import type { NormalizedUsage } from '../../utils/token-usage.js';

export type SubagentRole = 'explorer' | 'worker' | 'researcher' | 'mentor' | string;

export interface SubagentRequest {
  role: SubagentRole;
  task: string;
  writeBoundary?: string[];
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
}
