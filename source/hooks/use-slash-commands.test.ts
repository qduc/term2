import { it, expect } from 'vitest';
import {
  filterCommands,
  shouldAutocomplete,
  extractCommandArgs,
  executeSlashCommandSelection,
} from './use-slash-commands.js';
import type { SlashCommand } from '../slash-commands.js';

// Mock commands for testing
const MOCK_COMMANDS: SlashCommand[] = [
  { name: 'clear', description: 'Clear screen', action: () => {} },
  { name: 'quit', description: 'Quit app', action: () => {} },
  {
    name: 'model',
    description: 'Change model',
    action: () => {},
    expectsArgs: true,
  },
  { name: 'help', description: 'Show help', action: () => {} },
  {
    name: 'settings',
    description: 'Open settings',
    action: () => {},
    expectsArgs: true,
  },
];

// filterCommands tests
it('filterCommands - empty filter returns all commands in original order', () => {
  const result = filterCommands(MOCK_COMMANDS, '');
  expect(result.length).toBe(MOCK_COMMANDS.length);
  expect(result).toEqual(MOCK_COMMANDS);
});

it('filterCommands - simple partial match (case insensitive)', () => {
  const cases: Array<{ filter: string; expectedNames: string[] }> = [
    { filter: 'mod', expectedNames: ['model'] },
    { filter: 'MODEL', expectedNames: ['model'] },
    { filter: 'cle', expectedNames: ['clear'] },
    { filter: 'qui', expectedNames: ['quit'] },
    { filter: 'set', expectedNames: ['settings'] },
  ];

  for (const { filter, expectedNames } of cases) {
    const result = filterCommands(MOCK_COMMANDS, filter);
    const resultNames = result.map((cmd) => cmd.name);
    expect(resultNames, `Filter "${filter}" should match ${expectedNames.join(', ')}`).toEqual(expectedNames);
  }
});

it('filterCommands - no match returns empty array', () => {
  const result = filterCommands(MOCK_COMMANDS, 'xyz');
  expect(result.length).toBe(0);
});

it('filterCommands - exact match works', () => {
  const result = filterCommands(MOCK_COMMANDS, 'clear');
  expect(result.length).toBe(1);
  expect(result[0]!.name).toBe('clear');
});

it('filterCommands - command with arguments (space present)', () => {
  const cases: Array<{ filter: string; expectedNames: string[] }> = [
    { filter: 'model ', expectedNames: ['model'] },
    { filter: 'model gpt-4', expectedNames: ['model'] },
    { filter: 'model gpt-5.1', expectedNames: ['model'] },
    { filter: 'settings ', expectedNames: ['settings'] },
    { filter: 'settings agent.model', expectedNames: ['settings'] },
  ];

  for (const { filter, expectedNames } of cases) {
    const result = filterCommands(MOCK_COMMANDS, filter);
    const resultNames = result.map((cmd) => cmd.name);
    expect(resultNames, `Filter "${filter}" should match ${expectedNames.join(', ')}`).toEqual(expectedNames);
  }
});

it('filterCommands - command with args does not match other commands', () => {
  const result = filterCommands(MOCK_COMMANDS, 'modelx gpt-4');
  expect(result.length).toBe(0);
});

it('filterCommands - partial match includes substring anywhere', () => {
  // "el" should match "model" and "help" (both contain "el")
  const result = filterCommands(MOCK_COMMANDS, 'el');
  const resultNames = result.map((cmd) => cmd.name);
  expect(resultNames.includes('model')).toBe(true);
  expect(resultNames.includes('help')).toBe(true);
});

it('filterCommands - handles empty commands array', () => {
  const result = filterCommands([], 'test');
  expect(result.length).toBe(0);
});

it('filterCommands - multiple matches returned in order', () => {
  const commands: SlashCommand[] = [
    { name: 'test1', description: '', action: () => {} },
    { name: 'test2', description: '', action: () => {} },
    { name: 'test3', description: '', action: () => {} },
  ];

  const result = filterCommands(commands, 'test');
  expect(result.length).toBe(3);
  expect(result[0]!.name).toBe('test1');
  expect(result[1]!.name).toBe('test2');
  expect(result[2]!.name).toBe('test3');
});

// shouldAutocomplete tests
it('shouldAutocomplete - returns false when command does not expect args', () => {
  const command: SlashCommand = {
    name: 'clear',
    description: 'Clear screen',
    action: () => {},
  };

  expect(shouldAutocomplete(command, 'clear')).toBe(false);
  expect(shouldAutocomplete(command, 'cle')).toBe(false);
});

it('shouldAutocomplete - returns true when command expects args and filter is incomplete', () => {
  const command: SlashCommand = {
    name: 'model',
    description: 'Change model',
    action: () => {},
    expectsArgs: true,
  };

  const cases = [
    { filter: 'mod', expected: true },
    { filter: 'model', expected: true },
    { filter: 'MODEL', expected: true },
  ];

  for (const { filter, expected } of cases) {
    expect(shouldAutocomplete(command, filter), `Filter "${filter}" should autocomplete: ${expected}`).toBe(expected);
  }
});

it('shouldAutocomplete - returns false when command expects args and filter is complete', () => {
  const command: SlashCommand = {
    name: 'model',
    description: 'Change model',
    action: () => {},
    expectsArgs: true,
  };

  const cases = [
    { filter: 'model ', expected: false },
    { filter: 'model gpt-4', expected: false },
    { filter: 'MODEL ', expected: false },
  ];

  for (const { filter, expected } of cases) {
    expect(shouldAutocomplete(command, filter), `Filter "${filter}" should autocomplete: ${expected}`).toBe(expected);
  }
});

it('shouldAutocomplete - handles edge case with expectsArgs undefined', () => {
  const command: SlashCommand = {
    name: 'test',
    description: 'Test',
    action: () => {},
    expectsArgs: undefined,
  };

  expect(shouldAutocomplete(command, 'test')).toBe(false);
});

// extractCommandArgs tests
it('extractCommandArgs - extracts args after command name', () => {
  const cases: Array<{
    filter: string;
    commandName: string;
    expected: string;
  }> = [
    { filter: 'model gpt-4', commandName: 'model', expected: 'gpt-4' },
    { filter: 'model gpt-5.1', commandName: 'model', expected: 'gpt-5.1' },
    {
      filter: 'settings agent.model',
      commandName: 'settings',
      expected: 'agent.model',
    },
    { filter: 'test arg1 arg2', commandName: 'test', expected: 'arg1 arg2' },
  ];

  for (const { filter, commandName, expected } of cases) {
    const result = extractCommandArgs(filter, commandName);
    expect(result, `Args for "${filter}" with command "${commandName}"`).toBe(expected);
  }
});

it('extractCommandArgs - returns empty string when no args', () => {
  const cases = [
    { filter: 'model', commandName: 'model' },
    { filter: 'model ', commandName: 'model' },
    { filter: 'model  ', commandName: 'model' },
  ];

  for (const { filter, commandName } of cases) {
    const result = extractCommandArgs(filter, commandName);
    expect(result, `No args for "${filter}"`).toBe('');
  }
});

it('extractCommandArgs - trims whitespace from args', () => {
  const cases = [
    { filter: 'model   gpt-4', commandName: 'model', expected: 'gpt-4' },
    { filter: 'model gpt-4  ', commandName: 'model', expected: 'gpt-4' },
    { filter: 'model   gpt-4  ', commandName: 'model', expected: 'gpt-4' },
  ];

  for (const { filter, commandName, expected } of cases) {
    const result = extractCommandArgs(filter, commandName);
    expect(result, `Trimmed args for "${filter}"`).toBe(expected);
  }
});

it('extractCommandArgs - handles args with special characters', () => {
  const cases = [
    {
      filter: 'cmd arg-with-dashes',
      commandName: 'cmd',
      expected: 'arg-with-dashes',
    },
    {
      filter: 'cmd arg_with_underscores',
      commandName: 'cmd',
      expected: 'arg_with_underscores',
    },
    {
      filter: 'cmd arg.with.dots',
      commandName: 'cmd',
      expected: 'arg.with.dots',
    },
    {
      filter: 'cmd /path/to/file',
      commandName: 'cmd',
      expected: '/path/to/file',
    },
  ];

  for (const { filter, commandName, expected } of cases) {
    const result = extractCommandArgs(filter, commandName);
    expect(result, `Special chars in args for "${filter}"`).toBe(expected);
  }
});

it('extractCommandArgs - handles empty filter', () => {
  const result = extractCommandArgs('', 'cmd');
  expect(result).toBe('');
});

// Integration tests combining multiple functions
it('Integration - filter and autocomplete flow for command with args', () => {
  const command: SlashCommand = {
    name: 'model',
    description: 'Change model',
    action: () => {},
    expectsArgs: true,
  };

  // User types "mod"
  const filtered1 = filterCommands([command], 'mod');
  expect(filtered1.length).toBe(1);
  expect(shouldAutocomplete(filtered1[0]!, 'mod')).toBe(true);

  // User types "model "
  const filtered2 = filterCommands([command], 'model ');
  expect(filtered2.length).toBe(1);
  expect(shouldAutocomplete(filtered2[0]!, 'model ')).toBe(false);

  // User types "model gpt-4"
  const args = extractCommandArgs('model gpt-4', 'model');
  expect(args).toBe('gpt-4');
});

it('Integration - filter and execute flow for command without args', () => {
  const command: SlashCommand = {
    name: 'clear',
    description: 'Clear screen',
    action: () => {},
  };

  // User types "cle"
  const filtered = filterCommands([command], 'cle');
  expect(filtered.length).toBe(1);
  expect(shouldAutocomplete(filtered[0]!, 'cle')).toBe(false);

  // Extract args (should be empty)
  const args = extractCommandArgs('clear', 'clear');
  expect(args).toBe('');
});

it('executeSlashCommandSelection clears input after successful command execution', () => {
  let input = '/cle';
  let cursorOverride: number | null = 4;
  let closed = false;
  let actionCalled = false;

  executeSlashCommandSelection({
    command: {
      name: 'clear',
      description: 'Clear screen',
      action: () => {
        actionCalled = true;
        return true;
      },
    },
    filter: 'cle',
    setInput: (next) => {
      input = next;
    },
    setCursorOverride: (next) => {
      cursorOverride = next;
    },
    close: () => {
      closed = true;
    },
  });

  expect(actionCalled).toBe(true);
  expect(closed).toBe(true);
  expect(input).toBe('');
  expect(cursorOverride).toBe(null);
});

it('executeSlashCommandSelection autocompletes and executes for expectsArgs commands', () => {
  let input = '/mod';
  let cursorOverride: number | null = null;
  let closed = false;
  let actionCalled = false;

  executeSlashCommandSelection({
    command: {
      name: 'model',
      description: 'Change model',
      expectsArgs: true,
      // Real model command returns false on no-args (keeps input for further typing)
      action: () => {
        actionCalled = true;
        return false;
      },
    },
    filter: 'mod',
    setInput: (next) => {
      input = next;
    },
    setCursorOverride: (next) => {
      cursorOverride = next;
    },
    close: () => {
      closed = true;
    },
  });

  expect(actionCalled).toBe(true);
  expect(closed).toBe(true);
  expect(input).toBe('/model ');
  expect(cursorOverride).toBe(7);
});

it('executeSlashCommandSelection executes undo command after autocomplete', () => {
  let input = '/un';
  let cursorOverride: number | null = null;
  let closed = false;
  let undoMenuOpened = false;

  executeSlashCommandSelection({
    command: {
      name: 'undo',
      description: 'Undo the last user message',
      expectsArgs: true,
      // Real undo command returns true when opening undo menu
      action: () => {
        undoMenuOpened = true;
        return true;
      },
    },
    filter: 'un',
    setInput: (next) => {
      input = next;
    },
    setCursorOverride: (next) => {
      cursorOverride = next;
    },
    close: () => {
      closed = true;
    },
  });

  expect(undoMenuOpened).toBe(true);
  expect(closed).toBe(true);
  expect(input).toBe('');
  expect(cursorOverride).toBe(null);
});
