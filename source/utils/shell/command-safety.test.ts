import { it, expect } from 'vitest';
import { validateCommandSafety } from './command-safety/index.js';

it('throws on empty command', () => {
  expect(() => validateCommandSafety('')).toThrow(/Command cannot be empty/);
});

const approvalRequiredCommands = [
  'git log (',
  'rm -rf /',
  'echo $(rm -rf /)',
  'cat .env',
  'cat /etc/passwd',
  'python script.py',
  'cat ~/.ssh/id_rsa',
  'cat $HOME/.env',
  'cat /home/test/.gitconfig',
  'cat < /etc/passwd',
  'echo hi > /etc/hosts',
  'sed -i "s/foo/bar/" file.txt',
  'sed -i.bak "s/foo/bar/" file.txt',
  'sed "s/foo/bar/" input.txt > output.txt',
] as const;

it.each(approvalRequiredCommands)('requires approval for %s', (command) => {
  expect(validateCommandSafety(command)).toBe(true);
});

const safeCommands = [
  'echo firmware.rm',
  'sed -n "1,10p" file.txt',
  'sed "s/foo/bar/" file.txt',
  'echo "test" | sed "s/foo/bar/"',
  'sed "s/foo/bar/" < input.txt',
] as const;

it.each(safeCommands)('allows safe command %s without approval', (command) => {
  expect(validateCommandSafety(command)).toBe(false);
});
