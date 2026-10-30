import { isDeniedReadApproveAnswer, isDockerHostControlApproveAnswer, isReadFileSessionApproveAnswer, } from '../../contracts/conversation.js';
export function routeConversationTurnSubmission(input) {
    if (input.waitingForAskUserAnswer) {
        return { kind: 'approval_answer', answer: 'y', approvalAnswer: input.text };
    }
    if (input.waitingForRejectionReason) {
        return { kind: 'rejection_reason', reason: input.text };
    }
    if (input.waitingForApproval) {
        return { kind: 'blocked' };
    }
    return { kind: 'pass_through' };
}
export function normalizeApprovalDecision(answer) {
    if (isDeniedReadApproveAnswer(answer) ||
        isDockerHostControlApproveAnswer(answer) ||
        isReadFileSessionApproveAnswer(answer)) {
        return { answer };
    }
    return { answer: 'y', approvalAnswer: answer };
}
//# sourceMappingURL=conversation-input-routing.js.map