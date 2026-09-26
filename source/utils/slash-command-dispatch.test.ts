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

  it('consumes an unregistered command name but keeps the typed text to fix', () => {
    const replaceInput = vi.fn();

    const handled = tryExecuteSlashCommand('/nonexistent foo', [], replaceInput);

    expect(handled).toBe(true);
    expect(replaceInput).not.toHaveBeenCalled();
  });

  it('consumes unknown command names and reports nearby candidates', () => {
    const replaceInput = vi.fn();
    const notify = vi.fn();
    const handled = tryExecuteSlashCommand(
      '/re',
      [
        { name: 'resume', description: 'Resume', action: vi.fn() },
        { name: 'rewind', description: 'Rewind', action: vi.fn() },
      ],
      replaceInput,
      notify,
    );
    expect(handled).toBe(true);
    expect(notify).toHaveBeenCalledWith('Ambiguous command /re: /resume, /rewind');
    expect(replaceInput).not.toHaveBeenCalled();
  });

  it('does not treat paths with further slashes as commands', () => {
    const notify = vi.fn();
    expect(tryExecuteSlashCommand('/tmp/foo is broken', [], vi.fn(), notify)).toBe(false);
    expect(notify).not.toHaveBeenCalled();
  });

  it('blocks unknown command-like first tokens from falling through as chat', () => {
    const notify = vi.fn();
    expect(tryExecuteSlashCommand('/exot', [], vi.fn(), notify)).toBe(true);
    expect(notify).toHaveBeenCalledWith('Unknown command /exot');
  });

  it('suggests nearby command names for mistyped commands', () => {
    const notify = vi.fn();
    const commands: SlashCommand[] = [{ name: 'model', description: 'Model', action: vi.fn() }];
    tryExecuteSlashCommand('/modle', commands, vi.fn(), notify);
    expect(notify).toHaveBeenCalledWith('Unknown command /modle. Did you mean /model?');
  });
});
