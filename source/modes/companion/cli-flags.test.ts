import test from 'ava';
import meow from 'meow';

/**
 * Tests for companion mode CLI flag parsing.
 * These tests verify that the --companion/-c flag is correctly parsed.
 */

function parseFlags(args: string[]) {
const cli = meow('', {
importMeta: import.meta,
argv: args,
flags: {
model: {
type: 'string',
alias: 'm',
},
reasoning: {
type: 'string',
alias: 'r',
},
companion: {
type: 'boolean',
alias: 'c',
},
},
});

return cli.flags;
}

test('--companion flag is parsed correctly', t => {
const result = parseFlags(['--companion']);
t.is(result.companion, true);
});

test('-c shorthand works', t => {
const result = parseFlags(['-c']);
t.is(result.companion, true);
});

test('companion flag defaults to false when not provided', t => {
const result = parseFlags([]);
t.is(result.companion, false);
});

test('companion flag coexists with other flags', t => {
const result = parseFlags(['-c', '-m', 'gpt-4o', '-r', 'high']);
t.is(result.companion, true);
t.is(result.model, 'gpt-4o');
t.is(result.reasoning, 'high');
});

test('long and short flags can be mixed', t => {
const result = parseFlags(['--companion', '--model', 'gpt-4']);
t.is(result.companion, true);
t.is(result.model, 'gpt-4');
});
