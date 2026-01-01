import test from 'ava';
import {
    classifyOutputType,
    shouldSummarize,
    getSummarizationPrompt,
} from './output-classifier.js';
import type {CommandEntry} from './context-buffer.js';

// Helper to create a test entry
function createEntry(
    command: string,
    output = '',
    exitCode = 0,
): CommandEntry {
    return {
        command,
        output,
        exitCode,
        timestamp: Date.now(),
        outputLines: output.split('\n').length,
    };
}

// classifyOutputType tests

test('classifies npm test as test_results', t => {
    const entry = createEntry('npm test', 'PASS');
    t.is(classifyOutputType(entry), 'test_results');
});

test('classifies yarn test as test_results', t => {
    const entry = createEntry('yarn test', 'PASS');
    t.is(classifyOutputType(entry), 'test_results');
});

test('classifies jest as test_results', t => {
    const entry = createEntry('jest --coverage', 'PASS');
    t.is(classifyOutputType(entry), 'test_results');
});

test('classifies vitest as test_results', t => {
    const entry = createEntry('vitest run', 'PASS');
    t.is(classifyOutputType(entry), 'test_results');
});

test('classifies ava as test_results', t => {
    const entry = createEntry('ava', 'PASS');
    t.is(classifyOutputType(entry), 'test_results');
});

test('classifies npm run build as build_output', t => {
    const entry = createEntry('npm run build', 'Building...');
    t.is(classifyOutputType(entry), 'build_output');
});

test('classifies tsc as build_output', t => {
    const entry = createEntry('tsc', 'Compiling...');
    t.is(classifyOutputType(entry), 'build_output');
});

test('classifies webpack as build_output', t => {
    const entry = createEntry('webpack --mode production', 'Building...');
    t.is(classifyOutputType(entry), 'build_output');
});

test('classifies git commands as git_output', t => {
    const entry = createEntry('git status', 'On branch main');
    t.is(classifyOutputType(entry), 'git_output');
});

test('classifies git diff as git_output', t => {
    const entry = createEntry('git diff HEAD~1', '+new line');
    t.is(classifyOutputType(entry), 'git_output');
});

test('classifies npm install as npm_output', t => {
    const entry = createEntry('npm install lodash', 'installed');
    t.is(classifyOutputType(entry), 'npm_output');
});

test('classifies yarn add as npm_output', t => {
    const entry = createEntry('yarn add lodash', 'installed');
    t.is(classifyOutputType(entry), 'npm_output');
});

test('classifies pnpm as npm_output', t => {
    const entry = createEntry('pnpm install', 'installed');
    t.is(classifyOutputType(entry), 'npm_output');
});

test('classifies failed command as error_output', t => {
    const entry = createEntry('unknown', 'error', 1);
    t.is(classifyOutputType(entry), 'error_output');
});

test('classifies unknown success as general', t => {
    const entry = createEntry('echo hello', 'hello', 0);
    t.is(classifyOutputType(entry), 'general');
});

test('classification is case insensitive', t => {
    const entry = createEntry('NPM TEST', 'PASS');
    t.is(classifyOutputType(entry), 'test_results');
});

// shouldSummarize tests

test('shouldSummarize returns false for small output', t => {
    const entry = createEntry('cmd', 'small output', 0);
    t.false(shouldSummarize(entry));
});

test('shouldSummarize returns false for simple commands', t => {
    const entry = createEntry('cd /path', '\n'.repeat(100), 0);
    entry.outputLines = 100;
    t.false(shouldSummarize(entry));
});

test('shouldSummarize returns false for pwd', t => {
    const entry = createEntry('pwd', '\n'.repeat(100), 0);
    entry.outputLines = 100;
    t.false(shouldSummarize(entry));
});

test('shouldSummarize returns false for echo', t => {
    const entry = createEntry('echo hello', '\n'.repeat(100), 0);
    entry.outputLines = 100;
    t.false(shouldSummarize(entry));
});

test('shouldSummarize returns true for large output', t => {
    const entry = createEntry('npm test', '\n'.repeat(100), 0);
    entry.outputLines = 100;
    t.true(shouldSummarize(entry));
});

test('shouldSummarize threshold is 50 lines', t => {
    const entry49 = createEntry('npm test', '\n'.repeat(49), 0);
    entry49.outputLines = 49;

    const entry50 = createEntry('npm test', '\n'.repeat(50), 0);
    entry50.outputLines = 50;

    t.false(shouldSummarize(entry49));
    t.true(shouldSummarize(entry50));
});

// getSummarizationPrompt tests

test('getSummarizationPrompt returns prompt for test_results', t => {
    const prompt = getSummarizationPrompt('test_results');
    t.true(prompt.includes('test results'));
});

test('getSummarizationPrompt returns prompt for build_output', t => {
    const prompt = getSummarizationPrompt('build_output');
    t.true(prompt.includes('build'));
});

test('getSummarizationPrompt returns prompt for git_output', t => {
    const prompt = getSummarizationPrompt('git_output');
    t.true(prompt.includes('git'));
});

test('getSummarizationPrompt returns prompt for error_output', t => {
    const prompt = getSummarizationPrompt('error_output');
    t.true(prompt.includes('error'));
});

test('getSummarizationPrompt returns prompt for general', t => {
    const prompt = getSummarizationPrompt('general');
    t.truthy(prompt);
    t.true(prompt.includes('Summarize'));
});
