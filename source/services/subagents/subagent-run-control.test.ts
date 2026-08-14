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

  it('rejects a steering message that would exceed the message bound without losing admitted guidance', () => {
    const control = new SubagentRunControl({ maxMailboxMessages: 2, maxMailboxCharacters: 50 });

    expect(control.enqueueSteering('first instruction')).toBe(true);
    expect(control.enqueueSteering('second instruction')).toBe(true);
    expect(control.enqueueSteering('third instruction')).toBe(false);

    expect(control.mailboxLimits).toEqual({ messages: 2, characters: 50 });
    expect(control.mailboxOccupancy).toEqual({ messages: 2, characters: 35 });
    expect(control.consumeSteering()).toBe('first instruction\nsecond instruction');
    expect(control.consumeSteering()).toBeUndefined();
  });

  it('rejects a steering message that would exceed the character bound without interrupting the segment', () => {
    const control = new SubagentRunControl({ maxMailboxCharacters: 20 });
    const controller = control.beginSegment();
    control.onToolStart();

    expect(control.enqueueSteering('1234567890')).toBe(true);
    expect(control.enqueueSteering('abcdefghij')).toBe(true);
    expect(control.enqueueSteering('K')).toBe(false);

    expect(control.mailboxOccupancy).toEqual({ messages: 2, characters: 20 });
    expect(controller.signal.aborted).toBe(false);
    expect(control.consumeSteering()).toBe('1234567890\nabcdefghij');
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

  it('reports one trimmed question text to both the asker and the run owner', () => {
    const control = new SubagentRunControl({ createQuestionId: () => 'question-1' });

    const asked = control.ask('  Which API should I use?  ');

    expect(asked.question).toBe('Which API should I use?');
    expect(control.pendingQuestion).toEqual({ messageId: 'question-1', question: 'Which API should I use?' });
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
