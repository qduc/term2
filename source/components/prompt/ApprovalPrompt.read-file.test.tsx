// @ts-expect-error IS_REACT_ACT_ENVIRONMENT is not in globalThis types
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import { it, expect } from 'vitest';
import React, { act } from 'react';
import ApprovalPrompt from './ApprovalPrompt.js';
import type { ApprovalDescriptor } from '../../contracts/conversation.js';
import { renderInAct, toVisibleText } from '../../test-helpers/ink-testing.js';

const writeInput = async (stdin: { write: (input: string) => void }, input: string) => {
  await act(async () => {
    stdin.write(input);
  });
  await new Promise((resolve) => setImmediate(resolve));
};

const approval: ApprovalDescriptor = {
  agentName: 'Agent',
  toolName: 'read_file',
  argumentsText: JSON.stringify({ path: '/outside/docs/guide.md' }),
  rawInterruption: { type: 'tool_approval_item' },
};

it.sequential('outside-workspace read approval offers session folder access', async () => {
  let answer: string | undefined;
  const result = await renderInAct(
    <ApprovalPrompt
      approval={approval}
      onApprove={(value) => {
        answer = value;
      }}
      onReject={() => {}}
    />,
  );

  expect(toVisibleText(result.lastFrame() ?? '')).toContain('Allow this folder for this session');

  await writeInput(result.stdin, '\u001B[B');
  await writeInput(result.stdin, '\r');

  expect(answer).toBe('allow-folder-session');
});
