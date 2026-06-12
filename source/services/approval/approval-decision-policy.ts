import type { LLMAdvisory } from '../../contracts/conversation.js';
import type { ShellAutoApprovalResolver } from './shell-auto-approval-resolver.js';

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
    if (context.toolName !== 'shell' && context.toolName !== 'bash') return 'prompt';
    if (!context.llmAdvisory) return 'prompt';
    if (this.shellAutoApproval.shouldAutoApprove(context.llmAdvisory)) return 'approve';
    return 'prompt';
  }
}
