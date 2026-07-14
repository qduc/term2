import { expect, it } from 'vitest';
import { normalizeApprovalDecision, routeConversationTurnSubmission } from './conversation-input-routing.js';

it('routes ask-user submissions to the approval answer path', () => {
  expect(
    routeConversationTurnSubmission({
      text: 'yes, proceed',
      waitingForAskUserAnswer: true,
      waitingForRejectionReason: false,
      waitingForApproval: false,
    }),
  ).toEqual({ kind: 'approval_answer', answer: 'y', approvalAnswer: 'yes, proceed' });
});

it('routes rejection reason submissions to the rejection path', () => {
  expect(
    routeConversationTurnSubmission({
      text: 'because of policy',
      waitingForAskUserAnswer: false,
      waitingForRejectionReason: true,
      waitingForApproval: false,
    }),
  ).toEqual({ kind: 'rejection_reason', reason: 'because of policy' });
});

it('keeps approval-blocked submissions blocked', () => {
  expect(
    routeConversationTurnSubmission({
      text: 'ignored',
      waitingForAskUserAnswer: false,
      waitingForRejectionReason: false,
      waitingForApproval: true,
    }),
  ).toEqual({ kind: 'blocked' });
});

it('normalizes denied-read approval answers without rewriting them', () => {
  expect(normalizeApprovalDecision('allow-once')).toEqual({ answer: 'allow-once' });
});

it('preserves the session folder approval answer', () => {
  expect(normalizeApprovalDecision('allow-folder-session')).toEqual({ answer: 'allow-folder-session' });
});

it('normalizes standard approval answers to y plus approval text', () => {
  expect(normalizeApprovalDecision('approval text')).toEqual({ answer: 'y', approvalAnswer: 'approval text' });
});
