import test from 'ava';
import { validateCommandSafety } from '../../dist/utils/command-safety/index.js';

test('throws on empty command', (t) => {
  t.throws(() => validateCommandSafety(''), {
    message: /Command cannot be empty/,
  });
});

test('flags dangerous direct command', (t) => {
  t.true(validateCommandSafety('rm -rf /'));
});

test('flags nested dangerous command in substitution', (t) => {
  t.true(validateCommandSafety('echo $(rm -rf /)'));
});

test('does not flag namespaced filenames', (t) => {
  t.false(validateCommandSafety('echo firmware.rm'));
});

test('flags hidden sensitive files as yellow (approval required)', (t) => {
  t.true(validateCommandSafety('cat .env'));
});

test('absolute system paths are red (now yellow-ish, needs approval)', (t) => {
  t.true(validateCommandSafety('cat /etc/passwd'));
});

test('unknown commands are yellow (audit)', (t) => {
  t.true(validateCommandSafety('python script.py'));
});

test('tilde ssh key is red (needs approval)', (t) => {
  t.true(validateCommandSafety('cat ~/.ssh/id_rsa'));
});

test('home env file via $HOME is red (needs approval)', (t) => {
  t.true(validateCommandSafety('cat $HOME/.env'));
});

test('absolute home dotfile is red (needs approval)', (t) => {
  t.true(validateCommandSafety('cat /home/test/.gitconfig'));
});

test('redirect reading system file is red (needs approval)', (t) => {
  t.true(validateCommandSafety('cat < /etc/passwd'));
});

test('redirect writing system file is red (needs approval)', (t) => {
  t.true(validateCommandSafety('echo hi > /etc/hosts'));
});

// Sed command tests
test('sed in-place edit is red (needs approval)', (t) => {
  t.true(validateCommandSafety('sed -i "s/foo/bar/" file.txt'));
});

test('sed in-place edit with backup is red (needs approval)', (t) => {
  t.true(validateCommandSafety('sed -i.bak "s/foo/bar/" file.txt'));
});

test('sed with output redirect is yellow (requires approval)', (t) => {
  t.true(validateCommandSafety('sed "s/foo/bar/" input.txt > output.txt'));
});

test('sed read-only with file argument is green (safe)', (t) => {
  t.false(validateCommandSafety('sed -n "1,10p" file.txt'));
});

test('sed read-only transformation is green (safe)', (t) => {
  t.false(validateCommandSafety('sed "s/foo/bar/" file.txt'));
});

test('sed with stdin piped is green (safe)', (t) => {
  t.false(validateCommandSafety('echo "test" | sed "s/foo/bar/"'));
});

test('sed reading from redirect is green (safe)', (t) => {
  t.false(validateCommandSafety('sed "s/foo/bar/" < input.txt'));
});
