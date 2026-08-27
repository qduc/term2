import { describe, expect, it, vi } from 'vitest';
import { guardAgainstBusyTurn } from './busy-turn-guard.js';
import type { SlashCommand } from '../slash-commands.js';

describe('guardAgainstBusyTurn', () => {
  const makeCommand = (action: SlashCommand['action']): SlashCommand => ({
    name: 'clear',
    description: 'Start a new conversation',
    action,
  });

  it('runs the wrapped action when no turn is in flight', () => {
    const action = vi.fn(() => true);
    const notify = vi.fn();
    const guarded = guardAgainstBusyTurn(makeCommand(action), { turnInFlight: () => false, notify });

    expect(guarded.action()).toBe(true);
    expect(action).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
  });

  it('refuses to run the action and notifies the user while a turn is in flight', () => {
    const action = vi.fn(() => true);
    const notify = vi.fn();
    const guarded = guardAgainstBusyTurn(makeCommand(action), { turnInFlight: () => true, notify });

    expect(guarded.action()).toBe(true);
    expect(action).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toContain('/clear');
    expect(notify.mock.calls[0][0]).toContain('agent is working');
  });

  it('preserves the command name in the refusal message for aliases', () => {
    const notify = vi.fn();
    const guarded = guardAgainstBusyTurn(
      makeCommand(() => true),
      { turnInFlight: () => true, notify },
    );

    const aliased = guardAgainstBusyTurn(
      { ...makeCommand(() => true), name: 'undo' },
      { turnInFlight: () => true, notify },
    );
    void guarded;
    aliased.action();

    expect(notify.mock.calls.at(-1)?.[0]).toContain('/undo');
  });

  it('forwards args to the wrapped action when not blocked', () => {
    const action = vi.fn(() => true);
    const guarded = guardAgainstBusyTurn(makeCommand(action), { turnInFlight: () => false, notify: vi.fn() });

    guarded.action('3');
    expect(action).toHaveBeenCalledWith('3');
  });

  it('keeps the wrapped command name and description on the guarded command', () => {
    const guarded = guardAgainstBusyTurn(
      makeCommand(() => true),
      { turnInFlight: () => false, notify: vi.fn() },
    );

    expect(guarded.name).toBe('clear');
    expect(guarded.description).toBe('Start a new conversation');
  });
});
