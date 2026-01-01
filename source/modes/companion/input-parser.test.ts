import test from 'ava';
import {
    parseCompanionInput,
    isShellPrompt,
    extractCommandFromPromptLine,
    CommandOutputBuffer,
} from './input-parser.js';

// parseCompanionInput tests

test('parseCompanionInput detects ?? query with content', t => {
    const result = parseCompanionInput('?? why did this fail');

    t.is(result.type, 'query');
    t.is(result.content, 'why did this fail');
});

test('parseCompanionInput detects bare ?? query', t => {
    const result = parseCompanionInput('??');

    t.is(result.type, 'query');
    t.is(result.content, '');
});

test('parseCompanionInput detects ?? with extra spaces', t => {
    const result = parseCompanionInput('??   how do I fix this   ');

    t.is(result.type, 'query');
    t.is(result.content, 'how do I fix this');
});

test('parseCompanionInput detects !auto command', t => {
    const result = parseCompanionInput('!auto fix the tests');

    t.is(result.type, 'auto');
    t.is(result.content, 'fix the tests');
});

test('parseCompanionInput detects bare !auto', t => {
    const result = parseCompanionInput('!auto');

    t.is(result.type, 'auto');
    t.is(result.content, '');
});

test('parseCompanionInput returns normal for regular input', t => {
    const result = parseCompanionInput('npm test');

    t.is(result.type, 'normal');
    t.is(result.content, 'npm test');
});

test('parseCompanionInput handles whitespace-only input', t => {
    const result = parseCompanionInput('   ');

    t.is(result.type, 'normal');
    t.is(result.content, '');
});

test('parseCompanionInput does not detect ?? in middle of string', t => {
    const result = parseCompanionInput('echo "?? test"');

    t.is(result.type, 'normal');
    t.is(result.content, 'echo "?? test"');
});

// isShellPrompt tests

test('isShellPrompt detects bash prompt ending with $', t => {
    t.true(isShellPrompt('user@host:~/project$ '));
    t.true(isShellPrompt('$ '));
    t.true(isShellPrompt('[~/project]$ '));
});

test('isShellPrompt detects zsh prompt ending with %', t => {
    t.true(isShellPrompt('% '));
    t.true(isShellPrompt('user@host % '));
});

test('isShellPrompt detects prompt ending with >', t => {
    t.true(isShellPrompt('> '));
    t.true(isShellPrompt('PS1> '));
});

test('isShellPrompt detects oh-my-zsh prompt', t => {
    t.true(isShellPrompt('❯ '));
    t.true(isShellPrompt('~/project ❯ '));
});

test('isShellPrompt returns false for regular output', t => {
    t.false(isShellPrompt('npm test'));
    t.false(isShellPrompt('error: file not found'));
    t.false(isShellPrompt(''));
});

// extractCommandFromPromptLine tests

test('extractCommandFromPromptLine extracts command after $', t => {
    const result = extractCommandFromPromptLine('user@host:~$ npm test');
    t.is(result, 'npm test');
});

test('extractCommandFromPromptLine extracts command after %', t => {
    const result = extractCommandFromPromptLine('% git status');
    t.is(result, 'git status');
});

test('extractCommandFromPromptLine returns null for prompt only', t => {
    const result = extractCommandFromPromptLine('user@host:~$ ');
    t.is(result, null);
});

test('extractCommandFromPromptLine returns null for non-prompt line', t => {
    const result = extractCommandFromPromptLine('npm test output');
    t.is(result, null);
});

// CommandOutputBuffer tests

test('CommandOutputBuffer starts not waiting for output', t => {
    const buffer = new CommandOutputBuffer();
    t.false(buffer.isWaitingForOutput);
});

test('CommandOutputBuffer tracks current command', t => {
    const buffer = new CommandOutputBuffer();

    buffer.startCommand('npm test');

    t.true(buffer.isWaitingForOutput);
});

test('CommandOutputBuffer returns null when no command boundary', t => {
    const buffer = new CommandOutputBuffer();
    buffer.startCommand('npm test');

    const result = buffer.processData('test output\nmore output');

    t.is(result, null);
});

test('CommandOutputBuffer detects command completion', t => {
    const buffer = new CommandOutputBuffer();
    buffer.startCommand('npm test');

    buffer.processData('PASS test.js\n');
    const result = buffer.processData('user@host:~$ ');

    t.not(result, null);
    t.is(result?.command, 'npm test');
    t.true(result?.output.includes('PASS test.js'));
});

test('CommandOutputBuffer resets after command completion', t => {
    const buffer = new CommandOutputBuffer();
    buffer.startCommand('npm test');
    buffer.processData('output\nuser@host:~$ ');

    t.false(buffer.isWaitingForOutput);
});

test('CommandOutputBuffer.clear resets state', t => {
    const buffer = new CommandOutputBuffer();
    buffer.startCommand('npm test');
    buffer.processData('output');

    buffer.clear();

    t.false(buffer.isWaitingForOutput);
    t.is(buffer.promptLine, '');
});
