import { describe, expect, it } from 'vitest';
import { deriveInputOwner } from './input-owner.js';

describe('deriveInputOwner', () => {
  it('returns input when nothing is pending', () => {
    expect(
      deriveInputOwner({
        handoffStage: null,
        pendingSurgeTurn: null,
        pendingLargeUncachedTurn: null,
        waitingForApproval: false,
        waitingForRejectionReason: false,
        waitingForAskUserAnswer: false,
        pendingApproval: null,
        queuePaused: false,
        isProcessing: false,
      }),
    ).toEqual({ kind: 'input' });
  });

  it('prefers handoff confirm over everything else', () => {
    expect(
      deriveInputOwner({
        handoffStage: 'confirm_model',
        pendingSurgeTurn: {},
        pendingLargeUncachedTurn: {},
        waitingForApproval: true,
        pendingApproval: {},
        queuePaused: true,
        waitingForRejectionReason: false,
        waitingForAskUserAnswer: false,
        isProcessing: true,
      }).kind,
    ).toBe('handoff-confirm');
  });

  it('resolves surge prompt before large-uncached', () => {
    expect(
      deriveInputOwner({
        handoffStage: null,
        pendingSurgeTurn: {},
        pendingLargeUncachedTurn: {},
        waitingForApproval: true,
        pendingApproval: {},
        queuePaused: true,
        waitingForRejectionReason: false,
        waitingForAskUserAnswer: false,
        isProcessing: true,
      }).kind,
    ).toBe('input-surge');
  });

  it('resolves large-uncached prompt before approval/queue', () => {
    expect(
      deriveInputOwner({
        handoffStage: null,
        pendingSurgeTurn: null,
        pendingLargeUncachedTurn: {},
        waitingForApproval: true,
        pendingApproval: {},
        queuePaused: true,
        waitingForRejectionReason: false,
        waitingForAskUserAnswer: false,
        isProcessing: true,
      }).kind,
    ).toBe('large-uncached');
  });

  it('resolves approval owner when pendingApproval and waitingForApproval', () => {
    expect(
      deriveInputOwner({
        handoffStage: null,
        pendingSurgeTurn: null,
        pendingLargeUncachedTurn: null,
        waitingForApproval: true,
        pendingApproval: {} as unknown,
        queuePaused: false,
        waitingForRejectionReason: false,
        waitingForAskUserAnswer: false,
        isProcessing: false,
      }).kind,
    ).toBe('approval');
  });

  it('does NOT make approval own input while processing', () => {
    expect(
      deriveInputOwner({
        handoffStage: null,
        pendingSurgeTurn: null,
        pendingLargeUncachedTurn: null,
        waitingForApproval: true,
        pendingApproval: {} as unknown,
        queuePaused: false,
        waitingForRejectionReason: false,
        waitingForAskUserAnswer: false,
        isProcessing: true,
      }).kind,
    ).toBe('input');
  });

  it('does NOT make approval own input during rejection-reason entry', () => {
    expect(
      deriveInputOwner({
        handoffStage: null,
        pendingSurgeTurn: null,
        pendingLargeUncachedTurn: null,
        // The contract: when entering a rejection reason, the InputBox owns
        // input so the user can type. Owner must stay `input`, not `approval`.
        waitingForApproval: true,
        pendingApproval: {} as unknown,
        queuePaused: false,
        waitingForRejectionReason: true,
        waitingForAskUserAnswer: false,
        isProcessing: false,
      }).kind,
    ).toBe('input');
  });

  it('does NOT make approval own input during ask-user-answer entry', () => {
    expect(
      deriveInputOwner({
        handoffStage: null,
        pendingSurgeTurn: null,
        pendingLargeUncachedTurn: null,
        waitingForApproval: true,
        pendingApproval: {} as unknown,
        queuePaused: false,
        waitingForRejectionReason: false,
        waitingForAskUserAnswer: true,
        isProcessing: false,
      }).kind,
    ).toBe('input');
  });

  it('resolves queue-paused owner', () => {
    expect(
      deriveInputOwner({
        handoffStage: null,
        pendingSurgeTurn: null,
        pendingLargeUncachedTurn: null,
        waitingForApproval: false,
        pendingApproval: null,
        queuePaused: true,
        waitingForRejectionReason: false,
        waitingForAskUserAnswer: false,
        isProcessing: false,
      }).kind,
    ).toBe('queue-paused');
  });

  it('resolves standard-mode confirm', () => {
    expect(
      deriveInputOwner({
        handoffStage: 'confirm_standard_mode',
        pendingSurgeTurn: null,
        pendingLargeUncachedTurn: null,
        waitingForApproval: false,
        pendingApproval: null,
        queuePaused: true,
        waitingForRejectionReason: false,
        waitingForAskUserAnswer: false,
        isProcessing: false,
      }).kind,
    ).toBe('standard-mode-confirm');
  });
});
