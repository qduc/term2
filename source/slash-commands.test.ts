import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { resolveSlashCommand } from './slash-commands.js';
import type { SlashCommand } from './slash-commands.js';

const command = (name: string): SlashCommand => ({
  name,
  description: '',
  action: () => {},
});

it('resolveSlashCommand returns exact command matches first', () => {
  const undo = command('undo');
  const commands = [command('usage'), undo];

  expect(resolveSlashCommand(commands, 'undo')).toBe(undo);
});

it('resolveSlashCommand returns a unique command prefix match', () => {
  const undo = command('undo');
  const commands = [command('clear'), command('quit'), undo];

  expect(resolveSlashCommand(commands, 'u')).toBe(undo);
});

it('resolveSlashCommand ignores ambiguous command prefixes', () => {
  const commands = [command('clear'), command('copy')];

  expect(resolveSlashCommand(commands, 'c')).toBe(undefined);
});
