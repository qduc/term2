// @ts-expect-error IS_REACT_ACT_ENVIRONMENT is not in globalThis types
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import { it, expect } from 'vitest';
import React, { act } from 'react';
import ApprovalPrompt from './ApprovalPrompt.js';
import type { ApprovalDescriptor } from '../../contracts/conversation.js';
import { renderInAct, toVisibleText } from '../../test-helpers/ink-testing.js';

const ARROW_DOWN = String.fromCharCode(27) + '[B';

const writeInput = async (stdin: { write: (input: string) => void }, input: string) => {
  await act(async () => {
    stdin.write(input);
  });
  await new Promise((resolve) => setImmediate(resolve));
};

const makeApproval = (toolName: string, args: Record<string, unknown>): ApprovalDescriptor => ({
  agentName: 'Agent',
  toolName,
  argumentsText: JSON.stringify(args),
  rawInterruption: { type: 'tool_approval_item' },
});

it.sequential('outside-workspace grep approval offers the shared session folder grant', async () => {
  let answer: string | undefined;
  const result = await renderInAct(
    <ApprovalPrompt
      approval={makeApproval('grep', { pattern: 'needle', path: '/outside/docs' })}
      onApprove={(value) => {
        answer = value;
      }}
      onReject={() => {}}
    />,
  );

  const frame = toVisibleText(result.lastFrame() ?? '');
  expect(frame).toContain('Allow this folder for this session');
  // The prompt is reused across approval kinds, so it must name this one.
  expect(frame).toContain('wants to read outside the workspace');
  expect(frame).toContain('Allow this read outside the workspace?');
  expect(frame).toContain('read_file, grep and glob');
  expect(frame).toContain('/outside/docs');

  await writeInput(result.stdin, ARROW_DOWN);
  await writeInput(result.stdin, '\r');

  expect(answer).toBe('allow-folder-session');
});

it.sequential('outside-workspace glob approval names the directory of an absolute pattern', async () => {
  const result = await renderInAct(
    <ApprovalPrompt
      approval={makeApproval('glob', { pattern: '/outside/models/run_*.sh' })}
      onApprove={() => {}}
      onReject={() => {}}
    />,
  );

  const frame = toVisibleText(result.lastFrame() ?? '');
  expect(frame).toContain('Allow this folder for this session');
  expect(frame).toContain('/outside/models');
});

it.sequential('a shell approval keeps the generic wording and offers no folder grant', async () => {
  const result = await renderInAct(
    <ApprovalPrompt
      approval={makeApproval('shell', { command: 'npm test' })}
      onApprove={() => {}}
      onReject={() => {}}
    />,
  );

  const frame = toVisibleText(result.lastFrame() ?? '');
  expect(frame).toContain('Allow this action?');
  expect(frame).not.toContain('Allow this folder for this session');
  expect(frame).not.toContain('wants to read outside the workspace');
});
