import test from 'ava';
import {validateCommandSafety} from '../../dist/utils/command-safety.js';

test('throws on empty command', t => {
    t.throws(() => validateCommandSafety(''), {message: /Command cannot be empty/});
});

test('flags dangerous direct command', t => {
    t.true(validateCommandSafety('rm -rf /'));
});

test('flags nested dangerous command in substitution', t => {
    t.true(validateCommandSafety('echo $(rm -rf /)'));
});

test('does not flag namespaced filenames', t => {
    t.false(validateCommandSafety('echo firmware.rm'));
});
