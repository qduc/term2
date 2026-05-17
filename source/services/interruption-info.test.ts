import test from 'ava';
import {
  asRecord,
  getString,
  getMethod,
  getCallIdFromObject,
  getCommandFromArgs,
  getToolInfoFromInterruption,
} from './interruption-info.js';

test('asRecord returns the object for plain records and undefined otherwise', (t) => {
  t.deepEqual(asRecord({ a: 1 }), { a: 1 });
  t.is(asRecord(null), undefined);
  t.is(asRecord(undefined), undefined);
  t.is(asRecord([1, 2]), undefined);
  t.is(asRecord('string'), undefined);
});

test('getString returns string values and undefined for non-strings', (t) => {
  t.is(getString({ a: 'hello' }, 'a'), 'hello');
  t.is(getString({ a: 42 }, 'a'), undefined);
  t.is(getString(undefined, 'a'), undefined);
  t.is(getString({ a: undefined }, 'a'), undefined);
});

test('getMethod returns callable function or null', (t) => {
  const target = {
    fn: (x: number) => x + 1,
    notFn: 42,
  };
  const fn = getMethod<[number], number>(target, 'fn');
  t.truthy(fn);
  t.is(fn?.(2), 3);
  t.is(getMethod(target, 'notFn'), null);
  t.is(getMethod(target, 'missing'), null);
  t.is(getMethod(undefined, 'fn'), null);
});

test('getMethod returns bound function preserving target context', (t) => {
  class TestClass {
    public value = 42;
    getValue() {
      return this.value;
    }
  }
  const instance = new TestClass();
  const getValue = getMethod<[], number>(instance, 'getValue');
  t.truthy(getValue);
  t.is(getValue?.(), 42);
});

test('getCallIdFromObject reads canonical id keys at top level', (t) => {
  t.is(getCallIdFromObject({ callId: 'a' }), 'a');
  t.is(getCallIdFromObject({ call_id: 'b' }), 'b');
  t.is(getCallIdFromObject({ tool_call_id: 'c' }), 'c');
  t.is(getCallIdFromObject({ toolCallId: 'd' }), 'd');
  t.is(getCallIdFromObject({ id: 'e' }), 'e');
});

test('getCallIdFromObject falls back to rawItem keys when top-level is missing', (t) => {
  t.is(getCallIdFromObject({ rawItem: { callId: 'x' } }), 'x');
  t.is(getCallIdFromObject({ rawItem: { id: 'y' } }), 'y');
  t.is(getCallIdFromObject({}), undefined);
  t.is(getCallIdFromObject(null), undefined);
});

test('getCommandFromArgs handles JSON-string command shape', (t) => {
  t.is(getCommandFromArgs(JSON.stringify({ command: 'ls -la' })), 'ls -la');
});

test('getCommandFromArgs handles old commands array shape', (t) => {
  t.is(getCommandFromArgs(JSON.stringify({ commands: ['ls', 'pwd'] })), 'ls\npwd');
});

test('getCommandFromArgs returns string verbatim if not JSON', (t) => {
  t.is(getCommandFromArgs('echo hi'), 'echo hi');
});

test('getCommandFromArgs handles object command', (t) => {
  t.is(getCommandFromArgs({ command: 'whoami' }), 'whoami');
});

test('getCommandFromArgs handles object with arguments JSON string', (t) => {
  t.is(getCommandFromArgs({ arguments: JSON.stringify({ a: 1 }) }), '{"a":1}');
});

test('getCommandFromArgs returns empty string for falsy input', (t) => {
  t.is(getCommandFromArgs(undefined), '');
  t.is(getCommandFromArgs(null), '');
  t.is(getCommandFromArgs(''), '');
});

test('getToolInfoFromInterruption reads function-tool shape', (t) => {
  const info = getToolInfoFromInterruption({
    name: 'shell',
    arguments: { command: 'ls' },
  });
  t.is(info.toolName, 'shell');
  t.is(info.argumentsText, 'ls');
  t.deepEqual(info.rawArguments, { command: 'ls' });
});

test('getToolInfoFromInterruption reads shell_call action.commands array', (t) => {
  const info = getToolInfoFromInterruption({
    name: 'shell',
    type: 'shell_call',
    action: { commands: ['ls', 'pwd'] },
  });
  t.is(info.toolName, 'shell');
  t.is(info.argumentsText, 'ls\npwd');
});

test('getToolInfoFromInterruption defaults toolName to unknown', (t) => {
  const info = getToolInfoFromInterruption({});
  t.is(info.toolName, 'unknown');
  t.is(info.argumentsText, '');
});
