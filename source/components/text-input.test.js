import test from 'ava';
import React, {useState} from 'react';
import {Box, Text} from 'ink';
import {render} from 'ink-testing-library';
// Import the built component (tests run against compiled files)
import {TextInput} from '../../dist/components/TextInput.js';

const stripAnsi = s => s.replaceAll(/\u001B\[[0-9;]*m/g, '');

// Helper wrapper to make TextInput controlled and expose current value in output
const Controlled = ({
  initial = '',
  placeholder,
  multiLine = false,
  onChangeSpy,
  onSubmitSpy,
}) => {
  const [value, setValue] = useState(initial);
  const handleChange = v => {
    onChangeSpy?.(v);
    setValue(v);
  };
  const handleSubmit = v => {
    onSubmitSpy?.(v);
  };
  return React.createElement(
    Box,
    null,
    React.createElement(TextInput, {
      value,
      onChange: handleChange,
      onSubmit: handleSubmit,
      placeholder,
      focus: true,
      multiLine,
    }),
    // Echo the current value after a separator for easy assertions.
    // Replace newlines with \n to keep lastFrame() single-line for checks.
    React.createElement(
      Text,
      null,
      '|' + value.replaceAll('\n', '\\n')
    )
  );
};

test('renders placeholder with cursor when empty', t => {
  const {lastFrame} = render(
    React.createElement(Controlled, {placeholder: 'Type here...'})
  );
  const frame = lastFrame();
  t.true(frame.includes('Type here...'));
});

test('typing inserts characters and updates value', async t => {
  const calls = [];
  const {stdin, lastFrame} = render(
    React.createElement(Controlled, {onChangeSpy: v => calls.push(v)})
  );
  stdin.write('abc');
  await new Promise(r => setTimeout(r, 10));
  const frame = lastFrame();
  t.true(calls.includes('abc'));
  t.true(stripAnsi(frame).includes('|abc'));
});

test('respects cursorOverride when provided', async t => {
  // Render raw component to validate visual cursor placement
  const {lastFrame, rerender} = render(
    React.createElement(
      Box,
      null,
      React.createElement(TextInput, {
        value: 'abcd',
        onChange: () => {},
        cursorOverride: 2,
        focus: true,
      })
    )
  );
  await new Promise(r => setTimeout(r, 10));
  let frame = stripAnsi(lastFrame());
  // Expect "ab" then an inverted char (either 'c' or space if at end); we check plain text order
  t.true(frame.includes('ab'));
  // Change cursorOverride and ensure frame updates
  rerender(
    React.createElement(
      Box,
      null,
      React.createElement(TextInput, {
        value: 'abcd',
        onChange: () => {},
        cursorOverride: 0,
        focus: true,
      })
    )
  );
  await new Promise(r => setTimeout(r, 10));
  frame = stripAnsi(lastFrame());
  t.true(frame.includes('abcd'));
});

test('masking renders masked characters', t => {
  const {lastFrame} = render(
    React.createElement(
      Box,
      null,
      React.createElement(TextInput, {
        value: 'secret',
        onChange: () => {},
        mask: '*',
        focus: true,
      })
    )
  );
  const frame = lastFrame();
  t.true(frame.includes('******'));
});

test('multi-line value renders across lines', t => {
  const {lastFrame} = render(
    React.createElement(
      Box,
      null,
      React.createElement(TextInput, {
        value: 'row1\nrow2',
        onChange: () => {},
        focus: true,
      })
    )
  );
  const frame = lastFrame();
  t.true(frame.includes('row1'));
  t.true(frame.includes('row2'));
});

test('enter triggers onSubmit in single-line mode', t => {
  let submitted;
  const {stdin} = render(
    React.createElement(Controlled, {
      initial: 'done',
      onSubmitSpy: v => (submitted = v),
    })
  );
  stdin.write('\r');
  t.is(submitted, 'done');
});

test('enter triggers onSubmit in multi-line mode', t => {
  let submitted;
  const {stdin} = render(
    React.createElement(Controlled, {
      initial: 'multi',
      multiLine: true,
      onSubmitSpy: v => (submitted = v),
    })
  );
  stdin.write('\r');
  t.is(submitted, 'multi');
});

test('Ctrl+J inserts newline in multi-line mode', async t => {
  const {stdin, lastFrame} = render(
    React.createElement(Controlled, {
      initial: 'line1',
      multiLine: true,
    })
  );
  stdin.write('\n');
  await new Promise(r => setTimeout(r, 10));
  const frame = stripAnsi(lastFrame());
  t.true(frame.includes('|line1\\n'));
});

test('pasting multi-paragraph text works', async t => {
  const {stdin, lastFrame} = render(
    React.createElement(Controlled, {
      initial: '',
      multiLine: true,
    })
  );
  stdin.write('p1\n\np2');
  await new Promise(r => setTimeout(r, 10));
  const frame = stripAnsi(lastFrame());
  t.true(frame.includes('|p1\\n\\np2'));
});

test('pasting CRLF multi-paragraph text preserves newlines', async t => {
  const {stdin, lastFrame} = render(
    React.createElement(Controlled, {
      initial: '',
      multiLine: true,
    })
  );
  // Simulate Windows-style newlines (CRLF)
  stdin.write('para1\r\n\r\npara2');
  await new Promise(r => setTimeout(r, 10));
  const frame = stripAnsi(lastFrame());
  // Expect normalized to \n with blank line preserved
  t.true(frame.includes('|para1\\n\\npara2'));
});

// Note: interactive key handling is covered indirectly via submit test above.
