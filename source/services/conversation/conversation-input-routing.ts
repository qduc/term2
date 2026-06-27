import { isDeniedReadApproveAnswer } from '../../contracts/conversation.js';

export type ConversationTurnSubmissionRoute =
  | { kind: 'approval_answer'; answer: string; approvalAnswer?: string }
  | { kind: 'rejection_reason'; reason: string }
  | { kind: 'blocked' }
  | { kind: 'pass_through' };

export function routeConversationTurnSubmission(input: {
  text: string;
  waitingForAskUserAnswer: boolean;
  waitingForRejectionReason: boolean;
  waitingForApproval: boolean;
}): ConversationTurnSubmissionRoute {
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

export function normalizeApprovalDecision(answer?: string): { answer: string; approvalAnswer?: string } {
  if (isDeniedReadApproveAnswer(answer)) {
    return { answer };
  }

  return { answer: 'y', approvalAnswer: answer };
}
