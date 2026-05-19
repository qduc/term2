import test from 'ava';
import { resolveSlashCommand } from './slash-commands.js';
import type { SlashCommand } from './slash-commands.js';

const command = (name: string): SlashCommand => ({
  name,
  description: '',
  action: () => {},
});

test('resolveSlashCommand returns exact command matches first', (t) => {
  const undo = command('undo');
  const commands = [command('usage'), undo];

  t.is(resolveSlashCommand(commands, 'undo'), undo);
});

test('resolveSlashCommand returns a unique command prefix match', (t) => {
  const undo = command('undo');
  const commands = [command('clear'), command('quit'), undo];

  t.is(resolveSlashCommand(commands, 'u'), undo);
});

test('resolveSlashCommand ignores ambiguous command prefixes', (t) => {
  const commands = [command('clear'), command('copy')];

  t.is(resolveSlashCommand(commands, 'c'), undefined);
});
