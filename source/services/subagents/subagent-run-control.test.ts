import { describe, expect, it, vi } from 'vitest';
import { SubagentRunControl } from './subagent-run-control.js';

describe('SubagentRunControl', () => {
  it('owns one current segment controller at a time', () => {
    const control = new SubagentRunControl();
    const first = control.beginSegment();

    expect(() => control.beginSegment()).toThrow('already active');
    control.endSegment(first);

    expect(control.beginSegment()).toBeInstanceOf(AbortController);
  });

  it('defers an interrupt until every active tool completes', () => {
    const control = new SubagentRunControl();
    const controller = control.beginSegment();

    control.onToolStart();
    control.onToolStart();
    control.enqueueSteering('Use the alternate approach.');
    expect(controller.signal.aborted).toBe(false);
    expect(control.activeToolCount).toBe(2);

    control.onToolComplete();
    expect(controller.signal.aborted).toBe(false);
    control.onToolComplete();

    expect(controller.signal.aborted).toBe(true);
    expect(control.activeToolCount).toBe(0);
  });

  it('bounds and coalesces steering messages without exposing its mailbox', () => {
    const control = new SubagentRunControl({ maxMailboxMessages: 2, maxMailboxCharacters: 50 });

    control.enqueueSteering('first instruction');
    control.enqueueSteering('second instruction');
    control.enqueueSteering('third instruction');

    expect(control.consumeSteering()).toBe('[Earlier steering omitted]\nsecond instruction\nthird instruction');
    expect(control.consumeSteering()).toBeUndefined();
  });

  it('drops oldest mailbox content when its character bound is exceeded', () => {
    const control = new SubagentRunControl({ maxMailboxCharacters: 20 });

    control.enqueueSteering('1234567890');
    control.enqueueSteering('abcdefghij');
    control.enqueueSteering('K');

    expect(control.consumeSteering()).toBe('[Earlier steering omitted]\nabcdefghij\nK');
  });

  it('allows one question waiter and rejects it during terminal cleanup', async () => {
    const control = new SubagentRunControl({ createQuestionId: () => 'question-1' });
    const first = control.ask('Which API should I use?');

    expect(first.messageId).toBe('question-1');
    expect(() => control.ask('Can I ask another?')).toThrow('already pending');

    control.settle(new Error('The subagent run was cancelled.'));
    await expect(first.answer).rejects.toThrow('cancelled');
    expect(control.pendingQuestion).toBeUndefined();
  });

  it('answers the one matching pending question and clears its waiter', async () => {
    const control = new SubagentRunControl({ createQuestionId: () => 'question-1' });
    const question = control.ask('Which API should I use?');

    expect(control.answer('wrong-id', 'Use it.')).toBe(false);
    expect(control.answer('question-1', 'Use the public API.')).toBe(true);
    await expect(question.answer).resolves.toBe('Use the public API.');
    expect(control.pendingQuestion).toBeUndefined();
  });

  it('aborts the current segment and rejects a pending question when cancellation is requested', async () => {
    const control = new SubagentRunControl();
    const controller = control.beginSegment();
    const abort = vi.fn();
    controller.signal.addEventListener('abort', abort);
    const question = control.ask('Should I continue?');

    control.requestCancellation();

    expect(control.cancellationRequested).toBe(true);
    expect(abort).toHaveBeenCalledOnce();
    await expect(question.answer).rejects.toThrow('cancelled');
    expect(control.pendingQuestion).toBeUndefined();
  });
});
