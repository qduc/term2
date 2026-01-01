import test from 'ava';
import {
    formatCommandIndex,
    generateCommandIndexPrompt,
    estimateTokens,
} from './command-index.js';
import type {CommandIndexEntry} from './context-buffer.js';

// Helper to create a test index entry
function createIndexEntry(
    index: number,
    command: string,
    exitCode = 0,
    relativeTime = '5s ago',
    outputLines = 10,
    hasErrors = false,
): CommandIndexEntry {
    return {
        index,
        command,
        exitCode,
        relativeTime,
        outputLines,
        hasErrors,
    };
}

test('formatCommandIndex returns message for empty array', t => {
    const result = formatCommandIndex([]);
    t.is(result, 'No recent commands.');
});

test('formatCommandIndex formats single entry', t => {
    const entries = [createIndexEntry(0, 'npm test', 0, '5s ago', 100)];

    const result = formatCommandIndex(entries);

    t.true(result.includes('[0]'));
    t.true(result.includes('npm test'));
    t.true(result.includes('✓'));
    t.true(result.includes('exit:0'));
    t.true(result.includes('5s ago'));
    t.true(result.includes('100 lines'));
});

test('formatCommandIndex shows ✗ for non-zero exit code', t => {
    const entries = [createIndexEntry(0, 'npm test', 1, '5s ago', 100)];

    const result = formatCommandIndex(entries);

    t.true(result.includes('✗'));
});

test('formatCommandIndex formats multiple entries', t => {
    const entries = [
        createIndexEntry(0, 'npm test', 1, '5s ago', 100),
        createIndexEntry(1, 'git status', 0, '30s ago', 10),
        createIndexEntry(2, 'npm install', 0, '2m ago', 500),
    ];

    const result = formatCommandIndex(entries);

    const lines = result.split('\n');
    t.is(lines.length, 3);
    t.true(lines[0].includes('[0]'));
    t.true(lines[1].includes('[1]'));
    t.true(lines[2].includes('[2]'));
});

test('formatCommandIndex truncates long commands', t => {
    const longCommand = 'npm run very-long-script-name-that-exceeds-width';
    const entries = [createIndexEntry(0, longCommand)];

    const result = formatCommandIndex(entries);

    // Should be truncated to 25 chars
    t.true(result.length < longCommand.length + 100);
});

test('generateCommandIndexPrompt includes context header', t => {
    const entries = [createIndexEntry(0, 'npm test')];

    const result = generateCommandIndexPrompt(entries);

    t.true(result.includes('Terminal Context'));
    t.true(result.includes('recent commands'));
});

test('generateCommandIndexPrompt includes formatted index', t => {
    const entries = [createIndexEntry(0, 'npm test', 0, '5s ago', 100)];

    const result = generateCommandIndexPrompt(entries);

    t.true(result.includes('npm test'));
    t.true(result.includes('[0]'));
});

test('generateCommandIndexPrompt includes tool usage hint', t => {
    const entries = [createIndexEntry(0, 'npm test')];

    const result = generateCommandIndexPrompt(entries);

    t.true(result.includes('terminal_history'));
});

test('estimateTokens returns reasonable estimate', t => {
    const entries = [
        createIndexEntry(0, 'npm test', 0, '5s ago', 100),
        createIndexEntry(1, 'git status', 0, '30s ago', 10),
    ];

    const tokens = estimateTokens(entries);

    // ~4 chars per token, each entry is ~60 chars
    t.true(tokens > 20);
    t.true(tokens < 100);
});

test('estimateTokens returns 0 for empty index', t => {
    const entries: CommandIndexEntry[] = [];

    const tokens = estimateTokens(entries);

    // "No recent commands." is ~20 chars, ~5 tokens
    t.true(tokens < 10);
});
