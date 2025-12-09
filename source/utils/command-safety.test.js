import test from 'ava';
import {validateCommandSafety} from '../../dist/utils/command-safety/index.js';

test('throws on empty command', t => {
    t.throws(() => validateCommandSafety(''), {
        message: /Command cannot be empty/,
    });
});

test('flags dangerous direct command', t => {
    t.throws(() => validateCommandSafety('rm -rf /'), {
        message: /RED|forbidden/i,
    });
});

test('flags nested dangerous command in substitution', t => {
    t.throws(() => validateCommandSafety('echo $(rm -rf /)'), {
        message: /RED|forbidden/i,
    });
});

test('does not flag namespaced filenames', t => {
    t.false(validateCommandSafety('echo firmware.rm'));
});

test('flags hidden sensitive files as yellow (approval required)', t => {
    t.true(validateCommandSafety('cat .env'));
});

test('absolute system paths are red (blocked)', t => {
    t.throws(() => validateCommandSafety('cat /etc/passwd'), {
        message: /RED|forbidden/i,
    });
});

test('unknown commands are yellow (audit)', t => {
    t.true(validateCommandSafety('python script.py'));
});

test('tilde ssh key is red (blocked)', t => {
    t.throws(() => validateCommandSafety('cat ~/.ssh/id_rsa'), {
        message: /RED|forbidden/i,
    });
});

test('home env file via $HOME is red (blocked)', t => {
    t.throws(() => validateCommandSafety('cat $HOME/.env'), {
        message: /RED|forbidden/i,
    });
});

test('absolute home dotfile is red (blocked)', t => {
    t.throws(() => validateCommandSafety('cat /home/test/.gitconfig'), {
        message: /RED|forbidden/i,
    });
});

test('redirect reading system file is red (blocked)', t => {
    t.throws(() => validateCommandSafety('cat < /etc/passwd'), {
        message: /RED|forbidden/i,
    });
});

test('redirect writing system file is red (blocked)', t => {
    t.throws(() => validateCommandSafety('echo hi > /etc/hosts'), {
        message: /RED|forbidden/i,
    });
});

// Sed command tests
test('sed in-place edit is red (blocked)', t => {
    t.throws(() => validateCommandSafety('sed -i "s/foo/bar/" file.txt'), {
        message: /RED|forbidden/i,
    });
});

test('sed in-place edit with backup is red (blocked)', t => {
    t.throws(() => validateCommandSafety('sed -i.bak "s/foo/bar/" file.txt'), {
        message: /RED|forbidden/i,
    });
});

test('sed with output redirect is yellow (requires approval)', t => {
    t.true(validateCommandSafety('sed "s/foo/bar/" input.txt > output.txt'));
});

test('sed read-only with file argument is green (safe)', t => {
    t.false(validateCommandSafety('sed -n "1,10p" file.txt'));
});

test('sed read-only transformation is green (safe)', t => {
    t.false(validateCommandSafety('sed "s/foo/bar/" file.txt'));
});

test('sed with stdin piped is green (safe)', t => {
    t.false(validateCommandSafety('echo "test" | sed "s/foo/bar/"'));
});

test('sed reading from redirect is green (safe)', t => {
    t.false(validateCommandSafety('sed "s/foo/bar/" < input.txt'));
});
