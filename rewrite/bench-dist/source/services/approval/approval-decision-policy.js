import { shouldBypassToolApproval, isAutoApprovableTool } from './shell-auto-approval-resolver.js';
export class ManualApprovalDecisionPolicy {
    async decide() {
        return 'prompt';
    }
}
export class ShellAutoApprovalDecisionPolicy {
    shellAutoApproval;
    constructor(shellAutoApproval) {
        this.shellAutoApproval = shellAutoApproval;
    }
    async decide(context) {
        if (shouldBypassToolApproval(context.toolName, this.shellAutoApproval.getAutoApproveMode()))
            return 'approve';
        if (!isAutoApprovableTool(context.toolName))
            return 'prompt';
        if (this.shellAutoApproval.shouldAutoApprove(context.llmAdvisory))
            return 'approve';
        return 'prompt';
    }
}
//# sourceMappingURL=approval-decision-policy.js.map