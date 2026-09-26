// @ts-expect-error IS_REACT_ACT_ENVIRONMENT is not in globalThis types
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import { it, expect } from 'vitest';
import React, { act } from 'react';
import ApprovalPrompt, { deniedReadOptionColor } from './ApprovalPrompt.js';
import { COLOR_DANGER, COLOR_SUCCESS } from '../theme.js';
import type { ApprovalDescriptor } from '../../contracts/conversation.js';
import { renderInAct, toVisibleText } from '../../test-helpers/ink-testing.js';

const writeInput = async (stdin: { write: (input: string) => void }, input: string) => {
  await act(async () => {
    stdin.write(input);
  });
  await new Promise((resolve) => setImmediate(resolve));
};

const makeDeniedReadApproval = (sensitive: boolean): ApprovalDescriptor => ({
  agentName: 'Agent',
  toolName: 'shell',
  argumentsText: JSON.stringify({
    command: 'cargo build',
    sandbox: 'default',
  }),
  rawInterruption: { type: 'shell' },
  deniedRead: {
    deniedPath: sensitive ? '/home/user/.ssh/id_rsa' : '/home/user/.cargo/registry/cache/index',
    suggestedParent: sensitive ? '/home/user/.ssh' : '/home/user/.cargo',
    sensitive,
    command: 'cargo build',
  },
});

it.sequential('ApprovalPrompt denied-read renders all 4 options for non-sensitive path', async () => {
  const result = await renderInAct(
    <ApprovalPrompt approval={makeDeniedReadApproval(false)} onApprove={() => {}} onReject={() => {}} />,
  );
  const frame = toVisibleText(result.lastFrame() ?? '');

  expect(frame).toContain('Sandbox blocked read access');
  expect(frame).toContain('.cargo/registry/cache/index');
  expect(frame).toContain('Deny');
  expect(frame).toContain('Allow once');
  expect(frame).toContain('Allow and remember this path');
  expect(frame).toContain('Run unsandboxed once');
  expect(frame).not.toContain('sensitive path');
});

it.sequential(
  'ApprovalPrompt denied-read colors actions by meaning and shows the complete keyboard footer',
  async () => {
    const result = await renderInAct(
      <ApprovalPrompt approval={makeDeniedReadApproval(false)} onApprove={() => {}} onReject={() => {}} />,
    );
    const frame = result.lastFrame() ?? '';

    expect(deniedReadOptionColor('Deny')).toBe(COLOR_DANGER);
    expect(deniedReadOptionColor('Allow once')).toBe(COLOR_SUCCESS);
    expect(toVisibleText(frame)).toContain(
      '↑↓ navigate │ 1-9 select │ y/n answer │ ⏎ select │ Esc interrupts the turn',
    );
  },
);

it.sequential('ApprovalPrompt denied-read number keys select the matching action', async () => {
  let rejected = false;
  const result = await renderInAct(
    <ApprovalPrompt
      approval={makeDeniedReadApproval(false)}
      onApprove={() => {}}
      onReject={() => {
        rejected = true;
      }}
    />,
  );

  await writeInput(result.stdin, '4');
  expect(rejected).toBe(true);
});

it.sequential('ApprovalPrompt check-in shows the shared footer and number keys continue or stop', async () => {
  let continued = false;
  let stopped = false;
  const approval = { ...makeDeniedReadApproval(false), checkIn: 'run_budget' as const };
  const result = await renderInAct(
    <ApprovalPrompt
      approval={approval}
      onApprove={() => {
        continued = true;
      }}
      onReject={() => {
        stopped = true;
      }}
    />,
  );

  expect(toVisibleText(result.lastFrame() ?? '')).toContain(
    '↑↓ navigate │ 1-9 select │ y/n answer │ ⏎ select │ Esc interrupts the turn',
  );
  await writeInput(result.stdin, '2');
  expect(continued).toBe(false);
  expect(stopped).toBe(true);
});

it.sequential('ApprovalPrompt denied-read suppresses "Allow and remember" for sensitive path', async () => {
  const result = await renderInAct(
    <ApprovalPrompt approval={makeDeniedReadApproval(true)} onApprove={() => {}} onReject={() => {}} />,
  );
  const frame = toVisibleText(result.lastFrame() ?? '');

  expect(frame).toContain('Sandbox blocked read access');
  expect(frame).toContain('.ssh/id_rsa');
  expect(frame).toContain('Deny');
  expect(frame).toContain('Allow once');
  expect(frame).toContain('Run unsandboxed once');
  // The "Allow and remember" option must NOT be present.
  expect(frame).not.toContain('Allow and remember this path');
  // Sensitive-path notice should appear.
  expect(frame).toContain('sensitive path');
});

it.sequential('ApprovalPrompt denied-read Enter on "Allow once" calls onApprove with allow-once', async () => {
  let approveArg: string | undefined;
  const result = await renderInAct(
    <ApprovalPrompt
      approval={makeDeniedReadApproval(false)}
      onApprove={(answer) => {
        approveArg = answer;
      }}
      onReject={() => {}}
    />,
  );
  // Default selection is index 0 ("Allow once").
  await writeInput(result.stdin, '\r'); // Enter
  expect(approveArg).toBe('allow-once');
});

it.sequential('ApprovalPrompt denied-read Enter on "Deny" calls onReject', async () => {
  let rejected = false;
  const result = await renderInAct(
    <ApprovalPrompt
      approval={makeDeniedReadApproval(false)}
      onApprove={() => {}}
      onReject={() => {
        rejected = true;
      }}
    />,
  );
  // Deny is last, after the one-time and broader grants.
  await writeInput(result.stdin, '\u001B[B'); // down arrow
  await writeInput(result.stdin, '\u001B[B');
  await writeInput(result.stdin, '\u001B[B');
  await writeInput(result.stdin, '\r'); // Enter
  expect(rejected).toBe(true);
});

it.sequential('ApprovalPrompt leaves denied-read "y" to the stable application shortcut owner', async () => {
  let approveArg: string | undefined;
  const result = await renderInAct(
    <ApprovalPrompt
      approval={makeDeniedReadApproval(false)}
      onApprove={(answer) => {
        approveArg = answer;
      }}
      onReject={() => {}}
    />,
  );
  await writeInput(result.stdin, 'y');
  expect(approveArg).toBeUndefined();
});

it.sequential('ApprovalPrompt leaves denied-read "n" to the stable application shortcut owner', async () => {
  let rejected = false;
  const result = await renderInAct(
    <ApprovalPrompt
      approval={makeDeniedReadApproval(false)}
      onApprove={() => {}}
      onReject={() => {
        rejected = true;
      }}
    />,
  );
  await writeInput(result.stdin, 'n');
  expect(rejected).toBe(false);
});

it.sequential('ApprovalPrompt denied-read navigates to and selects "Run unsandboxed once"', async () => {
  let approveArg: string | undefined;
  const result = await renderInAct(
    <ApprovalPrompt
      approval={makeDeniedReadApproval(false)}
      onApprove={(answer) => {
        approveArg = answer;
      }}
      onReject={() => {}}
    />,
  );
  // Allow once → Allow and remember → Run unsandboxed once
  await writeInput(result.stdin, '\u001B[B'); // down → Allow once
  await writeInput(result.stdin, '\u001B[B'); // down → Allow and remember
  await writeInput(result.stdin, '\r'); // Enter
  expect(approveArg).toBe('unsandboxed-once');
});

it.sequential('ApprovalPrompt denied-read shows suggested parent for "allow and remember"', async () => {
  const result = await renderInAct(
    <ApprovalPrompt approval={makeDeniedReadApproval(false)} onApprove={() => {}} onReject={() => {}} />,
  );
  const frame = toVisibleText(result.lastFrame() ?? '');
  expect(frame).toContain('.cargo');
  expect(frame).toContain('persists this path for this project');
});
