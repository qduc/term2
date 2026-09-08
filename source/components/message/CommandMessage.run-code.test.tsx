// @ts-expect-error IS_REACT_ACT_ENVIRONMENT is not in globalThis types
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import { it, expect } from 'vitest';
import React from 'react';
import { renderInAct } from '../../test-helpers/ink-testing.js';
import CommandMessage from './CommandMessage.js';

const stripAnsi = (text: string) => text.replaceAll(/\[[0-9;]*m/g, '');

const CLEAN_OUTPUT = 'Result:\n{"matches":12}\n\n[3 tool calls: grep, read_file×2]';
const REFUSED_OUTPUT = [
  'Result:\n{"renamed":2}',
  'Refused (needs user approval and could not be completed from inside this script): search_replace',
  '[2 tool calls: grep, search_replace]',
].join('\n\n');

const args = { code: 'const hits = await tools.grep({ pattern: "x" });', description: 'count callers' };

it('run_code header reads as an action and omits the script body', async () => {
  const { lastFrame, unmount } = await renderInAct(
    <CommandMessage
      command="run_code — count callers"
      toolName="run_code"
      status="completed"
      success={true}
      toolArgs={args}
      output={CLEAN_OUTPUT}
    />,
  );

  const output = stripAnsi(lastFrame() ?? '');
  expect(output).toContain('count callers');
  expect(output).not.toContain('tools.grep');
  unmount();
});

it('run_code lists its nested calls and drops the duplicated summary line', async () => {
  const { lastFrame, unmount } = await renderInAct(
    <CommandMessage
      command="run_code — count callers"
      toolName="run_code"
      status="completed"
      success={true}
      toolArgs={args}
      output={CLEAN_OUTPUT}
    />,
  );

  const output = stripAnsi(lastFrame() ?? '');
  expect(output).toContain('grep');
  expect(output).toContain('read_file ×2');
  expect(output).toContain('{"matches":12}');
  expect(output).not.toContain('[3 tool calls');
  unmount();
});

it('run_code marks a refused nested call with its reason', async () => {
  const { lastFrame, unmount } = await renderInAct(
    <CommandMessage
      command="run_code — apply the rename"
      toolName="run_code"
      status="completed"
      success={true}
      toolArgs={{ ...args, description: 'apply the rename' }}
      output={REFUSED_OUTPUT}
    />,
  );

  const output = stripAnsi(lastFrame() ?? '');
  expect(output).toContain('search_replace — needs approval');
  expect(output).not.toContain('Refused (needs user approval');
  unmount();
});

it('concise mode stays on one line for a clean run', async () => {
  const { lastFrame, unmount } = await renderInAct(
    <CommandMessage
      command="run_code — count callers"
      toolName="run_code"
      status="completed"
      success={true}
      displayMode="concise"
      toolArgs={args}
      output={CLEAN_OUTPUT}
    />,
  );

  const output = stripAnsi(lastFrame() ?? '').trim();
  expect(output).toContain('count callers');
  expect(output).not.toContain('grep');
  expect(output.split('\n')).toHaveLength(1);
  unmount();
});

it('concise mode reports refused calls in the header', async () => {
  const { lastFrame, unmount } = await renderInAct(
    <CommandMessage
      command="run_code — apply the rename"
      toolName="run_code"
      status="completed"
      success={true}
      displayMode="concise"
      toolArgs={{ ...args, description: 'apply the rename' }}
      output={REFUSED_OUTPUT}
    />,
  );

  const output = stripAnsi(lastFrame() ?? '');
  expect(output).toContain('apply the rename (1 refused)');
  unmount();
});

it('falls back to the generic card when the result carries no call summary', async () => {
  const { lastFrame, unmount } = await renderInAct(
    <CommandMessage
      command="run_code — count callers"
      toolName="run_code"
      status="completed"
      success={true}
      toolArgs={args}
      output=""
    />,
  );

  const output = stripAnsi(lastFrame() ?? '');
  expect(output).toContain('count callers');
  expect(output).not.toContain('needs approval');
  unmount();
});
