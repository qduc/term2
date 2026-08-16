import type { LLMAdvisory } from '../../contracts/conversation.js';
import type { ShellAutoApprovalResolver } from './shell-auto-approval-resolver.js';
import { shouldBypassToolApproval } from './shell-auto-approval-resolver.js';

export interface ApprovalContext {
  toolName: string;
  argumentsText: string;
  callId?: string;
  llmAdvisory?: LLMAdvisory;
}

export interface ApprovalDecisionPolicy {
  decide(context: ApprovalContext): Promise<'approve' | 'reject' | 'prompt'>;
}

export class ManualApprovalDecisionPolicy implements ApprovalDecisionPolicy {
  async decide(): Promise<'prompt'> {
    return 'prompt';
  }
}

export class ShellAutoApprovalDecisionPolicy implements ApprovalDecisionPolicy {
  constructor(private readonly shellAutoApproval: ShellAutoApprovalResolver) {}

  async decide(context: ApprovalContext): Promise<'approve' | 'prompt'> {
    if (shouldBypassToolApproval(context.toolName, this.shellAutoApproval.getAutoApproveMode())) return 'approve';
    if (context.toolName !== 'shell' && context.toolName !== 'bash') return 'prompt';
    if (this.shellAutoApproval.shouldAutoApprove(context.llmAdvisory)) return 'approve';
    return 'prompt';
  }
}
