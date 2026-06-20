import { describe, it, expect } from 'vitest';
import {
  handoffFlowReducer,
  composeHandoffMessage,
  createInitialHandoffState,
  type HandoffState,
} from './handoff-flow-reducer.js';

describe('createInitialHandoffState', () => {
  it('returns null', () => {
    expect(createInitialHandoffState()).toBeNull();
  });
});

describe('composeHandoffMessage', () => {
  it('uses the captured handoff message when present', () => {
    const state: HandoffState = {
      capturedText: 'fix the bug',
      stage: 'selecting_model',
      handoffMessage: 'Refactor this',
    };
    expect(composeHandoffMessage(state)).toBe('Refactor this:\n\nfix the bug');
  });

  it('defaults to "Implement this" when no handoff message is set', () => {
    const state: HandoffState = { capturedText: 'fix the bug', stage: 'selecting_model' };
    expect(composeHandoffMessage(state)).toBe('Implement this:\n\nfix the bug');
  });

  it('defaults to "Implement this" when handoff message is empty string', () => {
    const state: HandoffState = { capturedText: 'fix the bug', stage: 'selecting_model', handoffMessage: '' };
    expect(composeHandoffMessage(state)).toBe('Implement this:\n\nfix the bug');
  });
});

describe('handoffFlowReducer', () => {
  describe('handoff/started', () => {
    it('begins a new flow in entering_message from any state', () => {
      expect(handoffFlowReducer(null, { type: 'handoff/started', capturedText: 'captured' })).toEqual({
        capturedText: 'captured',
        stage: 'entering_message',
      });
    });

    it('overwrites an in-flight flow', () => {
      const state: HandoffState = { capturedText: 'old', stage: 'selecting_effort', handoffMessage: 'msg' };
      expect(handoffFlowReducer(state, { type: 'handoff/started', capturedText: 'new' })).toEqual({
        capturedText: 'new',
        stage: 'entering_message',
      });
    });
  });

  describe('handoff/message_captured', () => {
    it('transitions entering_message to confirm_model and stores the message', () => {
      const state: HandoffState = { capturedText: 'captured', stage: 'entering_message' };
      expect(handoffFlowReducer(state, { type: 'handoff/message_captured', handoffMessage: 'Do it' })).toEqual({
        capturedText: 'captured',
        handoffMessage: 'Do it',
        stage: 'confirm_model',
      });
    });

    it('preserves capturedText from the prior state', () => {
      const state: HandoffState = { capturedText: 'keep me', stage: 'entering_message' };
      const next = handoffFlowReducer(state, { type: 'handoff/message_captured', handoffMessage: 'Do it' });
      expect(next?.capturedText).toBe('keep me');
    });

    it('is a no-op when not in entering_message', () => {
      const state: HandoffState = { capturedText: 'captured', stage: 'confirm_model' };
      expect(handoffFlowReducer(state, { type: 'handoff/message_captured', handoffMessage: 'Do it' })).toBe(state);
    });

    it('is a no-op when state is null', () => {
      expect(handoffFlowReducer(null, { type: 'handoff/message_captured', handoffMessage: 'Do it' })).toBeNull();
    });
  });

  describe('handoff/model_confirmed', () => {
    it('transitions confirm_model to selecting_model, preserving capturedText and message', () => {
      const state: HandoffState = { capturedText: 'captured', stage: 'confirm_model', handoffMessage: 'msg' };
      expect(handoffFlowReducer(state, { type: 'handoff/model_confirmed' })).toEqual({
        capturedText: 'captured',
        handoffMessage: 'msg',
        stage: 'selecting_model',
      });
    });

    // confirmHandoff is stage-agnostic in the hook (mirrors the original
    // implementation); the reducer must allow the transition from any non-null
    // stage, not only confirm_model.
    it('transitions entering_message directly to selecting_model', () => {
      const state: HandoffState = { capturedText: 'captured', stage: 'entering_message' };
      expect(handoffFlowReducer(state, { type: 'handoff/model_confirmed' })).toEqual({
        capturedText: 'captured',
        stage: 'selecting_model',
      });
    });

    it('is a no-op when state is null', () => {
      expect(handoffFlowReducer(null, { type: 'handoff/model_confirmed' })).toBeNull();
    });
  });

  describe('handoff/model_selected', () => {
    it('transitions selecting_model to selecting_effort', () => {
      const state: HandoffState = { capturedText: 'captured', stage: 'selecting_model', handoffMessage: 'msg' };
      expect(handoffFlowReducer(state, { type: 'handoff/model_selected' })).toEqual({
        capturedText: 'captured',
        handoffMessage: 'msg',
        stage: 'selecting_effort',
      });
    });

    it('is a no-op when not in selecting_model', () => {
      const state: HandoffState = { capturedText: 'captured', stage: 'confirm_model' };
      expect(handoffFlowReducer(state, { type: 'handoff/model_selected' })).toBe(state);
    });

    it('is a no-op when state is null', () => {
      expect(handoffFlowReducer(null, { type: 'handoff/model_selected' })).toBeNull();
    });
  });

  describe('handoff/standard_mode_requested', () => {
    it('transitions any non-null state to confirm_standard_mode', () => {
      const state: HandoffState = { capturedText: 'captured', stage: 'selecting_effort', handoffMessage: 'msg' };
      expect(handoffFlowReducer(state, { type: 'handoff/standard_mode_requested' })).toEqual({
        capturedText: 'captured',
        handoffMessage: 'msg',
        stage: 'confirm_standard_mode',
      });
    });

    it('is a no-op when state is null', () => {
      expect(handoffFlowReducer(null, { type: 'handoff/standard_mode_requested' })).toBeNull();
    });
  });

  describe('handoff/sent', () => {
    it('clears state to null from any non-null stage', () => {
      const state: HandoffState = { capturedText: 'captured', stage: 'selecting_effort', handoffMessage: 'msg' };
      expect(handoffFlowReducer(state, { type: 'handoff/sent' })).toBeNull();
    });

    it('stays null when already null', () => {
      expect(handoffFlowReducer(null, { type: 'handoff/sent' })).toBeNull();
    });
  });

  describe('handoff/cancelled', () => {
    it('clears state to null from any non-null stage', () => {
      const state: HandoffState = { capturedText: 'captured', stage: 'entering_message' };
      expect(handoffFlowReducer(state, { type: 'handoff/cancelled' })).toBeNull();
    });

    it('stays null when already null', () => {
      expect(handoffFlowReducer(null, { type: 'handoff/cancelled' })).toBeNull();
    });
  });
});
