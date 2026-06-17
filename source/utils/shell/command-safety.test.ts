import { it, expect } from 'vitest';
import { validateCommandSafety } from './command-safety/index.js';

it('throws on empty command', () => {
  expect(() => validateCommandSafety('')).toThrow(/Command cannot be empty/);
});

it('malformed trailing syntax is yellow (approval required)', () => {
  expect(validateCommandSafety('git log (')).toBe(true);
});

it('flags dangerous direct command', () => {
  expect(validateCommandSafety('rm -rf /')).toBe(true);
});

it('flags nested dangerous command in substitution', () => {
  expect(validateCommandSafety('echo $(rm -rf /)')).toBe(true);
});

it('does not flag namespaced filenames', () => {
  expect(validateCommandSafety('echo firmware.rm')).toBe(false);
});

it('flags hidden sensitive files as yellow (approval required)', () => {
  expect(validateCommandSafety('cat .env')).toBe(true);
});

it('absolute system paths are red (now yellow-ish, needs approval)', () => {
  expect(validateCommandSafety('cat /etc/passwd')).toBe(true);
});

it('unknown commands are yellow (audit)', () => {
  expect(validateCommandSafety('python script.py')).toBe(true);
});

it('tilde ssh key is red (needs approval)', () => {
  expect(validateCommandSafety('cat ~/.ssh/id_rsa')).toBe(true);
});

it('home env file via $HOME is red (needs approval)', () => {
  expect(validateCommandSafety('cat $HOME/.env')).toBe(true);
});

it('absolute home dotfile is red (needs approval)', () => {
  expect(validateCommandSafety('cat /home/test/.gitconfig')).toBe(true);
});

it('redirect reading system file is red (needs approval)', () => {
  expect(validateCommandSafety('cat < /etc/passwd')).toBe(true);
});

it('redirect writing system file is red (needs approval)', () => {
  expect(validateCommandSafety('echo hi > /etc/hosts')).toBe(true);
});

// Sed command tests
it('sed in-place edit is red (needs approval)', () => {
  expect(validateCommandSafety('sed -i "s/foo/bar/" file.txt')).toBe(true);
});

it('sed in-place edit with backup is red (needs approval)', () => {
  expect(validateCommandSafety('sed -i.bak "s/foo/bar/" file.txt')).toBe(true);
});

it('sed with output redirect is yellow (requires approval)', () => {
  expect(validateCommandSafety('sed "s/foo/bar/" input.txt > output.txt')).toBe(true);
});

it('sed read-only with file argument is green (safe)', () => {
  expect(validateCommandSafety('sed -n "1,10p" file.txt')).toBe(false);
});

it('sed read-only transformation is green (safe)', () => {
  expect(validateCommandSafety('sed "s/foo/bar/" file.txt')).toBe(false);
});

it('sed with stdin piped is green (safe)', () => {
  expect(validateCommandSafety('echo "test" | sed "s/foo/bar/"')).toBe(false);
});

it('sed reading from redirect is green (safe)', () => {
  expect(validateCommandSafety('sed "s/foo/bar/" < input.txt')).toBe(false);
});
