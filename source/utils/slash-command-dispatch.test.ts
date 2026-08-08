import { describe, expect, it, vi } from 'vitest';
import { tryExecuteSlashCommand } from './slash-command-dispatch.js';
import type { SlashCommand } from '../slash-commands.js';

describe('tryExecuteSlashCommand', () => {
  it('executes a registered command with its parsed args and clears input', () => {
    const action = vi.fn();
    const commands: SlashCommand[] = [{ name: 'model', description: 'Select model', action }];
    const replaceInput = vi.fn();

    const handled = tryExecuteSlashCommand('/model gpt-4 --provider=openai', commands, replaceInput);

    expect(handled).toBe(true);
    expect(action).toHaveBeenCalledWith('gpt-4 --provider=openai');
    expect(replaceInput).toHaveBeenCalledWith('');
  });

  it('does not clear input when the action explicitly returns false', () => {
    const action = vi.fn(() => false);
    const commands: SlashCommand[] = [{ name: 'model', description: 'Select model', action }];
    const replaceInput = vi.fn();

    const handled = tryExecuteSlashCommand('/model', commands, replaceInput);

    expect(handled).toBe(true);
    expect(replaceInput).not.toHaveBeenCalled();
  });

  it('returns false for plain, non-slash text and never calls any action', () => {
    const action = vi.fn();
    const commands: SlashCommand[] = [{ name: 'model', description: 'Select model', action }];
    const replaceInput = vi.fn();

    const handled = tryExecuteSlashCommand('just a message', commands, replaceInput);

    expect(handled).toBe(false);
    expect(action).not.toHaveBeenCalled();
    expect(replaceInput).not.toHaveBeenCalled();
  });

  it('returns false for a slash-shaped command name that is not registered', () => {
    const replaceInput = vi.fn();

    const handled = tryExecuteSlashCommand('/nonexistent foo', [], replaceInput);

    expect(handled).toBe(false);
    expect(replaceInput).not.toHaveBeenCalled();
  });
});
