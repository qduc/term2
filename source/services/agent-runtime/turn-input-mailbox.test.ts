import { describe, expect, it, vi } from 'vitest';
import { TurnInputMailbox } from './turn-input-mailbox.js';

const message = (content: string) => ({ type: 'message' as const, role: 'user' as const, content });

describe('TurnInputMailbox', () => {
  it('admits pending inputs in FIFO order and settles each entry once', async () => {
    const diagnostic = vi.fn();
    const mailbox = new TurnInputMailbox(diagnostic);
    mailbox.openTurn();
    const first = mailbox.offer([message('first')]);
    const second = mailbox.offer([message('second')]);
    const appended: string[] = [];

    mailbox.admitAtRequestBoundary((item) => appended.push(item.content as string), 3);
    mailbox.admitAtRequestBoundary((item) => appended.push(item.content as string), 4);

    await expect(Promise.all([first, second])).resolves.toEqual(['admitted', 'admitted']);
    expect(appended).toEqual(['first', 'second']);
    expect(diagnostic).toHaveBeenCalledTimes(1);
    expect(diagnostic).toHaveBeenCalledWith('Steer admitted at request boundary', { admitted: 2, turnCount: 3 });
  });

  it('retains inputs across a settled segment when the declared turn remains open', async () => {
    const mailbox = new TurnInputMailbox();
    mailbox.openTurn();
    mailbox.startSegment();
    mailbox.settleSegment({ paused: false, reason: { cancelled: true } });

    const pending = mailbox.offer([message('after segment abort')]);
    const appended: string[] = [];
    mailbox.startSegment();
    mailbox.admitAtRequestBoundary((item) => appended.push(item.content as string), 0);
    mailbox.settleSegment({ paused: false, reason: {} });

    await expect(pending).resolves.toBe('admitted');
    expect(appended).toEqual(['after segment abort']);
  });

  it('releases pending entries exactly once when the turn closes or aborts', async () => {
    const mailbox = new TurnInputMailbox();
    mailbox.openTurn();
    const onClose = mailbox.offer([message('close')]);
    mailbox.closeTurn();
    mailbox.closeTurn();
    await expect(onClose).resolves.toBe('released');

    mailbox.openTurn();
    const onAbort = mailbox.offer([message('abort')]);
    mailbox.abortTurn();
    mailbox.abortTurn();
    await expect(onAbort).resolves.toBe('released');
  });

  it('edits and retracts pending entries without changing FIFO position', async () => {
    const mailbox = new TurnInputMailbox();
    mailbox.openTurn();
    const first = mailbox.offer([message('first')], { id: 'first' });
    const retracted = mailbox.offer([message('original')], { id: 'edit' });
    const last = mailbox.offer([message('last')], { id: 'last' });

    expect(mailbox.edit('edit', [message('edited')])).toBe(true);
    expect(mailbox.retract('last')).toBe(true);
    expect(mailbox.retract('last')).toBe(false);
    const appended: string[] = [];
    mailbox.admitAtRequestBoundary((item) => appended.push(item.content as string), 0);

    await expect(Promise.all([first, retracted, last])).resolves.toEqual(['admitted', 'admitted', 'retracted']);
    expect(appended).toEqual(['first', 'edited']);
  });
});
