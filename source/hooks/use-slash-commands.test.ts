import test from 'ava';
import {filterCommands, shouldAutocomplete, extractCommandArgs} from './use-slash-commands.js';
import type {SlashCommand} from '../components/SlashCommandMenu.js';

// Mock commands for testing
const MOCK_COMMANDS: SlashCommand[] = [
	{name: 'clear', description: 'Clear screen', action: () => {}},
	{name: 'quit', description: 'Quit app', action: () => {}},
	{name: 'model', description: 'Change model', action: () => {}, expectsArgs: true},
	{name: 'help', description: 'Show help', action: () => {}},
	{name: 'settings', description: 'Open settings', action: () => {}, expectsArgs: true},
];

// filterCommands tests
test('filterCommands - empty filter returns all commands', t => {
	const result = filterCommands(MOCK_COMMANDS, '');
	t.is(result.length, MOCK_COMMANDS.length);
});

test('filterCommands - simple partial match (case insensitive)', t => {
	const cases: Array<{filter: string; expectedNames: string[]}> = [
		{filter: 'mod', expectedNames: ['model']},
		{filter: 'MODEL', expectedNames: ['model']},
		{filter: 'cle', expectedNames: ['clear']},
		{filter: 'qui', expectedNames: ['quit']},
		{filter: 'set', expectedNames: ['settings']},
	];

	for (const {filter, expectedNames} of cases) {
		const result = filterCommands(MOCK_COMMANDS, filter);
		const resultNames = result.map(cmd => cmd.name);
		t.deepEqual(
			resultNames,
			expectedNames,
			`Filter "${filter}" should match ${expectedNames.join(', ')}`
		);
	}
});

test('filterCommands - no match returns empty array', t => {
	const result = filterCommands(MOCK_COMMANDS, 'xyz');
	t.is(result.length, 0);
});

test('filterCommands - exact match works', t => {
	const result = filterCommands(MOCK_COMMANDS, 'clear');
	t.is(result.length, 1);
	t.is(result[0]!.name, 'clear');
});

test('filterCommands - command with arguments (space present)', t => {
	const cases: Array<{filter: string; expectedNames: string[]}> = [
		{filter: 'model ', expectedNames: ['model']},
		{filter: 'model gpt-4', expectedNames: ['model']},
		{filter: 'model gpt-5.1', expectedNames: ['model']},
		{filter: 'settings ', expectedNames: ['settings']},
		{filter: 'settings agent.model', expectedNames: ['settings']},
	];

	for (const {filter, expectedNames} of cases) {
		const result = filterCommands(MOCK_COMMANDS, filter);
		const resultNames = result.map(cmd => cmd.name);
		t.deepEqual(
			resultNames,
			expectedNames,
			`Filter "${filter}" should match ${expectedNames.join(', ')}`
		);
	}
});

test('filterCommands - command with args does not match other commands', t => {
	const result = filterCommands(MOCK_COMMANDS, 'modelx gpt-4');
	t.is(result.length, 0);
});

test('filterCommands - partial match includes substring anywhere', t => {
	// "el" should match "model" and "help" (both contain "el")
	const result = filterCommands(MOCK_COMMANDS, 'el');
	const resultNames = result.map(cmd => cmd.name);
	t.true(resultNames.includes('model'));
	t.true(resultNames.includes('help'));
});

test('filterCommands - handles empty commands array', t => {
	const result = filterCommands([], 'test');
	t.is(result.length, 0);
});

test('filterCommands - multiple matches returned in order', t => {
	const commands: SlashCommand[] = [
		{name: 'test1', description: '', action: () => {}},
		{name: 'test2', description: '', action: () => {}},
		{name: 'test3', description: '', action: () => {}},
	];

	const result = filterCommands(commands, 'test');
	t.is(result.length, 3);
	t.is(result[0]!.name, 'test1');
	t.is(result[1]!.name, 'test2');
	t.is(result[2]!.name, 'test3');
});

// shouldAutocomplete tests
test('shouldAutocomplete - returns false when command does not expect args', t => {
	const command: SlashCommand = {
		name: 'clear',
		description: 'Clear screen',
		action: () => {},
	};

	t.false(shouldAutocomplete(command, 'clear'));
	t.false(shouldAutocomplete(command, 'cle'));
});

test('shouldAutocomplete - returns true when command expects args and filter is incomplete', t => {
	const command: SlashCommand = {
		name: 'model',
		description: 'Change model',
		action: () => {},
		expectsArgs: true,
	};

	const cases = [
		{filter: 'mod', expected: true},
		{filter: 'model', expected: true},
		{filter: 'MODEL', expected: true},
	];

	for (const {filter, expected} of cases) {
		t.is(
			shouldAutocomplete(command, filter),
			expected,
			`Filter "${filter}" should autocomplete: ${expected}`
		);
	}
});

test('shouldAutocomplete - returns false when command expects args and filter is complete', t => {
	const command: SlashCommand = {
		name: 'model',
		description: 'Change model',
		action: () => {},
		expectsArgs: true,
	};

	const cases = [
		{filter: 'model ', expected: false},
		{filter: 'model gpt-4', expected: false},
		{filter: 'MODEL ', expected: false},
	];

	for (const {filter, expected} of cases) {
		t.is(
			shouldAutocomplete(command, filter),
			expected,
			`Filter "${filter}" should autocomplete: ${expected}`
		);
	}
});

test('shouldAutocomplete - handles edge case with expectsArgs undefined', t => {
	const command: SlashCommand = {
		name: 'test',
		description: 'Test',
		action: () => {},
		expectsArgs: undefined,
	};

	t.false(shouldAutocomplete(command, 'test'));
});

// extractCommandArgs tests
test('extractCommandArgs - extracts args after command name', t => {
	const cases: Array<{filter: string; commandName: string; expected: string}> = [
		{filter: 'model gpt-4', commandName: 'model', expected: 'gpt-4'},
		{filter: 'model gpt-5.1', commandName: 'model', expected: 'gpt-5.1'},
		{filter: 'settings agent.model', commandName: 'settings', expected: 'agent.model'},
		{filter: 'test arg1 arg2', commandName: 'test', expected: 'arg1 arg2'},
	];

	for (const {filter, commandName, expected} of cases) {
		const result = extractCommandArgs(filter, commandName);
		t.is(result, expected, `Args for "${filter}" with command "${commandName}"`);
	}
});

test('extractCommandArgs - returns empty string when no args', t => {
	const cases = [
		{filter: 'model', commandName: 'model'},
		{filter: 'model ', commandName: 'model'},
		{filter: 'model  ', commandName: 'model'},
	];

	for (const {filter, commandName} of cases) {
		const result = extractCommandArgs(filter, commandName);
		t.is(result, '', `No args for "${filter}"`);
	}
});

test('extractCommandArgs - trims whitespace from args', t => {
	const cases = [
		{filter: 'model   gpt-4', commandName: 'model', expected: 'gpt-4'},
		{filter: 'model gpt-4  ', commandName: 'model', expected: 'gpt-4'},
		{filter: 'model   gpt-4  ', commandName: 'model', expected: 'gpt-4'},
	];

	for (const {filter, commandName, expected} of cases) {
		const result = extractCommandArgs(filter, commandName);
		t.is(result, expected, `Trimmed args for "${filter}"`);
	}
});

test('extractCommandArgs - handles args with special characters', t => {
	const cases = [
		{filter: 'cmd arg-with-dashes', commandName: 'cmd', expected: 'arg-with-dashes'},
		{filter: 'cmd arg_with_underscores', commandName: 'cmd', expected: 'arg_with_underscores'},
		{filter: 'cmd arg.with.dots', commandName: 'cmd', expected: 'arg.with.dots'},
		{filter: 'cmd /path/to/file', commandName: 'cmd', expected: '/path/to/file'},
	];

	for (const {filter, commandName, expected} of cases) {
		const result = extractCommandArgs(filter, commandName);
		t.is(result, expected, `Special chars in args for "${filter}"`);
	}
});

test('extractCommandArgs - handles empty filter', t => {
	const result = extractCommandArgs('', 'cmd');
	t.is(result, '');
});

// Integration tests combining multiple functions
test('Integration - filter and autocomplete flow for command with args', t => {
	const command: SlashCommand = {
		name: 'model',
		description: 'Change model',
		action: () => {},
		expectsArgs: true,
	};

	// User types "mod"
	const filtered1 = filterCommands([command], 'mod');
	t.is(filtered1.length, 1);
	t.true(shouldAutocomplete(filtered1[0]!, 'mod'));

	// User types "model "
	const filtered2 = filterCommands([command], 'model ');
	t.is(filtered2.length, 1);
	t.false(shouldAutocomplete(filtered2[0]!, 'model '));

	// User types "model gpt-4"
	const args = extractCommandArgs('model gpt-4', 'model');
	t.is(args, 'gpt-4');
});

test('Integration - filter and execute flow for command without args', t => {
	const command: SlashCommand = {
		name: 'clear',
		description: 'Clear screen',
		action: () => {},
	};

	// User types "cle"
	const filtered = filterCommands([command], 'cle');
	t.is(filtered.length, 1);
	t.false(shouldAutocomplete(filtered[0]!, 'cle'));

	// Extract args (should be empty)
	const args = extractCommandArgs('clear', 'clear');
	t.is(args, '');
});
