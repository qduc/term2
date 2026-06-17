import { it, expect } from 'vitest';
import {
  asRecord,
  getString,
  getMethod,
  getCallIdFromObject,
  getCommandFromArgs,
  getToolInfoFromInterruption,
} from './interruption-info.js';

it('asRecord returns the object for plain records and undefined otherwise', () => {
  expect(asRecord({ a: 1 })).toEqual({ a: 1 });
  expect(asRecord(null)).toBe(undefined);
  expect(asRecord(undefined)).toBe(undefined);
  expect(asRecord([1, 2])).toBe(undefined);
  expect(asRecord('string')).toBe(undefined);
});

it('getString returns string values and undefined for non-strings', () => {
  expect(getString({ a: 'hello' }, 'a')).toBe('hello');
  expect(getString({ a: 42 }, 'a')).toBe(undefined);
  expect(getString(undefined, 'a')).toBe(undefined);
  expect(getString({ a: undefined }, 'a')).toBe(undefined);
});

it('getMethod returns callable function or null', () => {
  const target = {
    fn: (x: number) => x + 1,
    notFn: 42,
  };
  const fn = getMethod<[number], number>(target, 'fn');
  expect(fn).toBeTruthy();
  expect(fn?.(2)).toBe(3);
  expect(getMethod(target, 'notFn')).toBe(null);
  expect(getMethod(target, 'missing')).toBe(null);
  expect(getMethod(undefined, 'fn')).toBe(null);
});

it('getMethod returns bound function preserving target context', () => {
  class TestClass {
    public value = 42;
    getValue() {
      return this.value;
    }
  }
  const instance = new TestClass();
  const getValue = getMethod<[], number>(instance, 'getValue');
  expect(getValue).toBeTruthy();
  expect(getValue?.()).toBe(42);
});

it('getCallIdFromObject reads canonical id keys at top level', () => {
  expect(getCallIdFromObject({ callId: 'a' })).toBe('a');
  expect(getCallIdFromObject({ call_id: 'b' })).toBe('b');
  expect(getCallIdFromObject({ tool_call_id: 'c' })).toBe('c');
  expect(getCallIdFromObject({ toolCallId: 'd' })).toBe('d');
  expect(getCallIdFromObject({ id: 'e' })).toBe('e');
});

it('getCallIdFromObject falls back to rawItem keys when top-level is missing', () => {
  expect(getCallIdFromObject({ rawItem: { callId: 'x' } })).toBe('x');
  expect(getCallIdFromObject({ rawItem: { id: 'y' } })).toBe('y');
  expect(getCallIdFromObject({})).toBe(undefined);
  expect(getCallIdFromObject(null)).toBe(undefined);
});

it('getCallIdFromObject prefers rawItem.callId over wrapper id for approval items', () => {
  expect(
    getCallIdFromObject({
      type: 'tool_approval_item',
      id: 'approval-wrapper-id',
      rawItem: { id: 'fc_provider_item', callId: 'call-real-id' },
    }),
  ).toBe('call-real-id');
});

it('getCommandFromArgs handles JSON-string command shape', () => {
  expect(getCommandFromArgs(JSON.stringify({ command: 'ls -la' }))).toBe('ls -la');
});

it('getCommandFromArgs handles old commands array shape', () => {
  expect(getCommandFromArgs(JSON.stringify({ commands: ['ls', 'pwd'] }))).toBe('ls\npwd');
});

it('getCommandFromArgs returns string verbatim if not JSON', () => {
  expect(getCommandFromArgs('echo hi')).toBe('echo hi');
});

it('getCommandFromArgs handles object command', () => {
  expect(getCommandFromArgs({ command: 'whoami' })).toBe('whoami');
});

it('getCommandFromArgs handles object with arguments JSON string', () => {
  expect(getCommandFromArgs({ arguments: JSON.stringify({ a: 1 }) })).toBe('{"a":1}');
});

it('getCommandFromArgs returns empty string for falsy input', () => {
  expect(getCommandFromArgs(undefined)).toBe('');
  expect(getCommandFromArgs(null)).toBe('');
  expect(getCommandFromArgs('')).toBe('');
});

it('getToolInfoFromInterruption reads function-tool shape', () => {
  const info = getToolInfoFromInterruption({
    name: 'shell',
    arguments: { command: 'ls' },
  });
  expect(info.toolName).toBe('shell');
  expect(info.argumentsText).toBe('ls');
  expect(info.rawArguments).toEqual({ command: 'ls' });
});

it('getToolInfoFromInterruption reads shell_call action.commands array', () => {
  const info = getToolInfoFromInterruption({
    name: 'shell',
    type: 'shell_call',
    action: { commands: ['ls', 'pwd'] },
  });
  expect(info.toolName).toBe('shell');
  expect(info.argumentsText).toBe('ls\npwd');
});

it('getToolInfoFromInterruption defaults toolName to unknown', () => {
  const info = getToolInfoFromInterruption({});
  expect(info.toolName).toBe('unknown');
  expect(info.argumentsText).toBe('');
});
