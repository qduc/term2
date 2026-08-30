// @ts-expect-error IS_REACT_ACT_ENVIRONMENT is not in globalThis types
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import { it, expect } from 'vitest';
import React, { act } from 'react';
import ApprovalPrompt from './ApprovalPrompt.js';
import type { ApprovalDescriptor } from '../../contracts/conversation.js';
import {
  ASK_USER_CUSTOM_ANSWER_LABEL,
  ASK_USER_DECLINE_LABEL,
  ASK_USER_DECLINE_RESULT,
} from '../../tools/agent/ask-user-constants.js';
import { renderInAct, toVisibleText } from '../../test-helpers/ink-testing.js';

const writeInput = async (stdin: { write: (input: string) => void }, input: string) => {
  await act(async () => {
    stdin.write(input);
  });
  await new Promise((resolve) => setImmediate(resolve));
};

const baseApproval: ApprovalDescriptor = {
  agentName: 'Agent',
  toolName: 'ask_user',
  argumentsText: JSON.stringify({
    questions: [
      {
        question: 'Which option should I use?',
        options: [
          { label: 'Use the safe default', description: 'Recommended by the agent' },
          { label: 'Use the faster option', description: 'Optimizes for speed' },
        ],
      },
    ],
  }),
  rawInterruption: { type: 'ask_user' },
};

it.sequential('ApprovalPrompt renders ask_user question and options', async () => {
  const result = await renderInAct(
    <ApprovalPrompt approval={baseApproval} onApprove={() => {}} onReject={() => {}} onTypeAnswer={() => {}} />,
  );
  const { lastFrame } = result;

  const output = lastFrame() ?? '';
  expect(output.includes('Which option should I use?')).toBe(true);
  expect(output.includes('1. Use the safe default')).toBe(true);
  expect(output.includes('★')).toBe(true);
  expect(output.includes('Recommended by the agent')).toBe(true);
  expect(output.includes('2. Use the faster option')).toBe(true);
  expect(output.includes('Optimizes for speed')).toBe(false);
  expect(output.includes(ASK_USER_CUSTOM_ANSWER_LABEL)).toBe(true);
  expect(output.includes('1-3 select')).toBe(true);
  // The footer now uses the shared MenuFooter component, whose hint glyph is
  // "⏎" (matching every other menu in the app), not the word "enter".
  expect(output.includes('⏎ confirm')).toBe(true);
  expect(output.includes('esc cancel')).toBe(true);
  expect(output.includes('Use the safe default')).toBe(true);
  expect(output.includes('HELP & DETAILS')).toBe(false);
  expect(output.includes('Allow this action?')).toBe(false);
  expect(output.includes('Approve')).toBe(false);
});

it.sequential('ApprovalPrompt Escape cancels ask_user without submitting an answer', async () => {
  let cancelled = false;
  let approved = false;
  let rejected = false;
  const { stdin } = await renderInAct(
    <ApprovalPrompt
      approval={baseApproval}
      onApprove={() => {
        approved = true;
      }}
      onReject={() => {
        rejected = true;
      }}
      onCancel={() => {
        cancelled = true;
      }}
    />,
  );

  await writeInput(stdin, '\u001B');
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 60));
  });

  expect(cancelled).toBe(true);
  expect(approved).toBe(false);
  expect(rejected).toBe(false);
});

it.sequential('ApprovalPrompt shows unsandboxed shell approvals in the header', async () => {
  const approval: ApprovalDescriptor = {
    agentName: 'Agent',
    toolName: 'shell',
    argumentsText: JSON.stringify({ command: 'curl https://example.com', sandbox: 'unsandboxed' }),
    rawInterruption: { type: 'shell' },
  };

  const { lastFrame } = await renderInAct(
    <ApprovalPrompt approval={approval} onApprove={() => {}} onReject={() => {}} />,
  );

  const output = lastFrame() ?? '';
  expect(output.includes('Agent wants to run in unsandboxed mode:')).toBe(true);
  expect(output.includes('curl https://example.com')).toBe(true);
});

it.sequential('ApprovalPrompt renders mixed system safety findings as separate severity lines', async () => {
  const approval: ApprovalDescriptor = {
    agentName: 'Agent',
    toolName: 'shell',
    argumentsText: JSON.stringify({ command: 'pkill -f chrome; echo ok; kill 7372' }),
    rawInterruption: { type: 'shell' },
    llmAdvisory: {
      reasoning:
        'Blocked by safety heuristics (RED): YELLOW: unknown or unlisted command: pkill; GREEN: argument ok; RED: blocked command: kill. Manual approval is strictly required.\n\nModel advisory: This command attempts to stop a process.',
      approved: false,
      model: 'test-auto-model',
      source: 'system',
    },
  };

  const { lastFrame } = await renderInAct(
    <ApprovalPrompt approval={approval} onApprove={() => {}} onReject={() => {}} />,
  );

  const lines = toVisibleText(lastFrame() ?? '').split('\n');
  const findingLines = [
    ['YELLOW:', 'unknown or unlisted command: pkill'],
    ['GREEN:', 'argument ok'],
    ['RED:', 'blocked command: kill'],
  ].map(([level, detail]) => lines.findIndex((line) => line.includes(level) && line.includes(detail)));

  expect(findingLines.every((line) => line >= 0)).toBe(true);
  expect(new Set(findingLines).size).toBe(3);
  expect(lines.some((line) => line.includes('Manual approval is strictly required.'))).toBe(true);
  expect(lines.some((line) => line.includes('Model advisory:'))).toBe(true);
});

it.sequential('ApprovalPrompt renders the Docker host-control menu without ordinary approval choices', async () => {
  const approval: ApprovalDescriptor = {
    agentName: 'Agent',
    toolName: 'shell',
    argumentsText: JSON.stringify({ command: 'docker ps' }),
    rawInterruption: { type: 'shell' },
  };
  const { lastFrame } = await renderInAct(
    <ApprovalPrompt approval={approval} onApprove={() => {}} onReject={() => {}} />,
  );
  const output = lastFrame() ?? '';
  expect(output).toContain('Docker Host Control');
  expect(output).toContain('Deny');
  expect(output).toContain('Allow this command');
  expect(output).toContain('Allow for this session');
  expect(output).toContain('Always allow for this project');
  expect(output).not.toContain('Run unsandboxed once');
  expect(output).not.toContain('Approve');
  // Docker's danger border draws a "│" on every wrapped line of its body, so
  // normalize that border glyph away too, not just whitespace, before checking
  // the sentence reads as one contiguous line.
  expect(output.replace(/[│\s]+/g, ' ')).toContain(
    'This command can control your Docker daemon. It can bypass filesystem and network sandbox restrictions, mount host files, run privileged or persistent workloads, and is effectively equivalent to host access.',
  );
});

it.sequential('ApprovalPrompt sends the Docker one-shot grant answer', async () => {
  let answer: string | undefined;
  const approval: ApprovalDescriptor = {
    agentName: 'Agent',
    toolName: 'shell',
    argumentsText: JSON.stringify({ command: 'docker ps' }),
    rawInterruption: {},
  };
  const { stdin } = await renderInAct(
    <ApprovalPrompt
      approval={approval}
      onApprove={(value) => {
        answer = value;
      }}
      onReject={() => {}}
    />,
  );
  // Default selection is index 0 ('Allow this command')
  await writeInput(stdin, '\r');
  expect(answer).toBe('docker-allow-once');
});

it.sequential('ApprovalPrompt sends the Docker session grant answer', async () => {
  let answer: string | undefined;
  const approval = {
    ...baseApproval,
    toolName: 'shell',
    argumentsText: JSON.stringify({ command: 'docker ps' }),
  };
  const { stdin } = await renderInAct(
    <ApprovalPrompt approval={approval} onApprove={(value) => (answer = value)} onReject={() => {}} />,
  );
  await writeInput(stdin, '\u001B[B');
  await writeInput(stdin, '\u001B[B');
  await writeInput(stdin, '\r');
  expect(answer).toBe('docker-allow-session');
});

it.sequential('ApprovalPrompt sends the Docker project grant answer', async () => {
  let answer: string | undefined;
  const approval = {
    ...baseApproval,
    toolName: 'shell',
    argumentsText: JSON.stringify({ command: 'docker ps' }),
  };
  const { stdin } = await renderInAct(
    <ApprovalPrompt approval={approval} onApprove={(value) => (answer = value)} onReject={() => {}} />,
  );
  for (let index = 0; index < 3; index++) await writeInput(stdin, '\u001B[B');
  await writeInput(stdin, '\r');
  expect(answer).toBe('docker-allow-project');
});

it.sequential('ApprovalPrompt denies a Docker host-control request', async () => {
  let rejected = false;
  const approval = {
    ...baseApproval,
    toolName: 'shell',
    argumentsText: JSON.stringify({ command: 'docker ps' }),
  };
  const { stdin } = await renderInAct(
    <ApprovalPrompt approval={approval} onApprove={() => {}} onReject={() => (rejected = true)} />,
  );
  // Navigate down from index 0 ('Allow this command') to index 1 ('Deny')
  await writeInput(stdin, '\u001B[B');
  await writeInput(stdin, '\r');
  expect(rejected).toBe(true);
});

it.sequential('ApprovalPrompt renders the Docker menu for a command that does not read as Docker', async () => {
  // Indirect invocation: the command never mentions docker, so only the
  // producer -- which knows the session -- can tell this is a host-control
  // request. Without the resolved flag the prompt would offer ordinary choices
  // that the continuation refuses, stranding the command on approval.
  const approval: ApprovalDescriptor = {
    agentName: 'Agent',
    toolName: 'shell',
    argumentsText: JSON.stringify({ command: 'pnpm test' }),
    rawInterruption: { type: 'shell' },
    dockerHostControl: true,
  };
  const { lastFrame } = await renderInAct(
    <ApprovalPrompt approval={approval} onApprove={() => {}} onReject={() => {}} />,
  );
  const output = lastFrame() ?? '';
  expect(output).toContain('Docker Host Control');
  expect(output).toContain('Allow for this session');
  expect(output).not.toContain('Approve');
});

it.sequential('ApprovalPrompt keeps ordinary choices when no Docker host control was resolved', async () => {
  const approval: ApprovalDescriptor = {
    agentName: 'Agent',
    toolName: 'shell',
    argumentsText: JSON.stringify({ command: 'pnpm test' }),
    rawInterruption: { type: 'shell' },
  };
  const { lastFrame } = await renderInAct(
    <ApprovalPrompt approval={approval} onApprove={() => {}} onReject={() => {}} />,
  );
  expect(lastFrame() ?? '').not.toContain('Docker Host Control');
});

it.sequential('ApprovalPrompt identifies Docker host control from raw interruption arguments', async () => {
  const approval = {
    ...baseApproval,
    toolName: 'shell',
    argumentsText: 'docker ps',
    rawInterruption: { arguments: JSON.stringify({ command: 'docker ps' }) },
  };
  const { lastFrame } = await renderInAct(
    <ApprovalPrompt approval={approval} onApprove={() => {}} onReject={() => {}} />,
  );
  expect(lastFrame()).toContain('Docker Host Control');
});

it.sequential(
  'ApprovalPrompt shows unsandboxed shell approvals in the header with raw command argumentsText',
  async () => {
    const approval: ApprovalDescriptor = {
      agentName: 'Agent',
      toolName: 'shell',
      argumentsText: 'curl https://example.com',
      rawInterruption: {
        type: 'shell',
        arguments: {
          command: 'curl https://example.com',
          sandbox: 'unsandboxed',
        },
      },
    };

    const { lastFrame } = await renderInAct(
      <ApprovalPrompt approval={approval} onApprove={() => {}} onReject={() => {}} />,
    );

    const output = lastFrame() ?? '';
    expect(output.includes('Agent wants to run in unsandboxed mode:')).toBe(true);
    expect(output.includes('curl https://example.com')).toBe(true);
  },
);

it.sequential('ApprovalPrompt ask_user navigation wraps around menu items', async () => {
  const { lastFrame, stdin } = await renderInAct(
    <ApprovalPrompt approval={baseApproval} onApprove={() => {}} onReject={() => {}} onTypeAnswer={() => {}} />,
  );

  await writeInput(stdin, '\u001b[A');
  expect((lastFrame() ?? '').includes('Something else…')).toBe(true);

  await writeInput(stdin, '\u001b[B');
  expect((lastFrame() ?? '').includes('1. Use the safe default')).toBe(true);
});

it.sequential('ApprovalPrompt ask_user Enter on an option calls onApprove with the option text', async () => {
  let approved: string | undefined;
  const { stdin } = await renderInAct(
    <ApprovalPrompt
      approval={baseApproval}
      onApprove={(answer) => {
        approved = answer;
      }}
      onReject={() => {}}
      onTypeAnswer={() => {}}
    />,
  );

  await writeInput(stdin, '\r');
  expect(approved).toBe('Use the safe default');
});

it.sequential('ApprovalPrompt ask_user direct number keys select options immediately', async () => {
  let approved: string | undefined;
  let typed = false;
  const { stdin: stdin1 } = await renderInAct(
    <ApprovalPrompt
      approval={baseApproval}
      onApprove={(answer) => {
        approved = answer;
      }}
      onReject={() => {}}
      onTypeAnswer={() => {}}
    />,
  );

  await writeInput(stdin1, '1');
  expect(approved).toBe('Use the safe default');

  const { stdin: stdin2 } = await renderInAct(
    <ApprovalPrompt
      approval={baseApproval}
      onApprove={(answer) => {
        approved = answer;
      }}
      onReject={() => {}}
      onTypeAnswer={() => {}}
    />,
  );

  await writeInput(stdin2, '2');
  expect(approved).toBe('Use the faster option');

  const { stdin: stdin3 } = await renderInAct(
    <ApprovalPrompt
      approval={baseApproval}
      onApprove={() => {}}
      onReject={() => {}}
      onTypeAnswer={() => {
        typed = true;
      }}
    />,
  );

  await writeInput(stdin3, '3');
  expect(typed).toBe(true);
});

it.sequential('ApprovalPrompt ask_user Enter on Type custom answer calls onTypeAnswer', async () => {
  let typedAnswer = 0;
  const approval: ApprovalDescriptor = {
    ...baseApproval,
    argumentsText: JSON.stringify({
      questions: [
        {
          question: 'Which option should I use?',
          options: [
            { label: 'Use the safe default', description: 'Recommended by the agent' },
            { label: 'Use the faster option', description: 'Optimizes for speed' },
          ],
        },
      ],
    }),
  };

  const { stdin } = await renderInAct(
    <ApprovalPrompt
      approval={approval}
      onApprove={() => {}}
      onReject={() => {}}
      onTypeAnswer={() => {
        typedAnswer += 1;
      }}
    />,
  );

  // Menu: Option 0, Option 1, Something else...(index 2)
  await writeInput(stdin, '\u001B[B'); // down to Option 1
  await writeInput(stdin, '\u001B[B'); // down to Something else...
  await writeInput(stdin, '\r');

  expect(typedAnswer).toBe(1);
});

it.sequential('ApprovalPrompt ignores y for ask_user', async () => {
  let approveCount = 0;
  const { stdin } = await renderInAct(
    <ApprovalPrompt
      approval={baseApproval}
      onApprove={() => {
        approveCount += 1;
      }}
      onReject={() => {}}
      onTypeAnswer={() => {}}
    />,
  );

  await writeInput(stdin, 'y');

  expect(approveCount).toBe(0);
});

it.sequential('ApprovalPrompt ask_user still shows custom answer option without predefined options', async () => {
  const approval: ApprovalDescriptor = {
    ...baseApproval,
    argumentsText: JSON.stringify({
      questions: [{ question: 'Please answer this question' }],
    }),
  };

  const { lastFrame } = await renderInAct(
    <ApprovalPrompt approval={approval} onApprove={() => {}} onReject={() => {}} onTypeAnswer={() => {}} />,
  );

  const output = lastFrame() ?? '';
  expect(output.includes('Please answer this question')).toBe(true);
  expect(output.includes('Something else…')).toBe(true);
});

it.sequential('ApprovalPrompt renders multi-select options with checkboxes', async () => {
  const approval: ApprovalDescriptor = {
    agentName: 'Agent',
    toolName: 'ask_user',
    argumentsText: JSON.stringify({
      questions: [
        {
          question: 'Select tools to use',
          options: [
            { label: 'git', description: 'Version control' },
            { label: 'npm', description: 'JavaScript package manager' },
            { label: 'cargo', description: 'Rust package manager' },
          ],
          is_multi_select: true,
        },
      ],
    }),
    rawInterruption: { type: 'ask_user' },
  };

  const { lastFrame } = await renderInAct(
    <ApprovalPrompt approval={approval} onApprove={() => {}} onReject={() => {}} onTypeAnswer={() => {}} />,
  );

  const output = lastFrame() ?? '';
  expect(output.includes('[ ] git')).toBe(true);
  expect(output.includes('Version control')).toBe(true);
  expect(output.includes('[ ] npm')).toBe(true);
  expect(output.includes('JavaScript package manager')).toBe(false);
  expect(output.includes('[ ] cargo')).toBe(true);
  expect(output.includes('Rust package manager')).toBe(false);
  expect(output.includes('Submit answer')).toBe(true);
});

it.sequential('ApprovalPrompt toggles multi-select options and submits on Submit', async () => {
  const approval: ApprovalDescriptor = {
    agentName: 'Agent',
    toolName: 'ask_user',
    argumentsText: JSON.stringify({
      questions: [
        {
          question: 'Select tools to use',
          options: [
            { label: 'git', description: 'Version control' },
            { label: 'npm', description: 'JavaScript package manager' },
            { label: 'cargo', description: 'Rust package manager' },
          ],
          is_multi_select: true,
        },
      ],
    }),
    rawInterruption: { type: 'ask_user' },
  };

  let approved: string | undefined;
  const { lastFrame, stdin } = await renderInAct(
    <ApprovalPrompt
      approval={approval}
      onApprove={(answer) => {
        approved = answer;
      }}
      onReject={() => {}}
      onTypeAnswer={() => {}}
    />,
  );

  // Toggle first option (git) with spacebar
  await writeInput(stdin, ' ');
  expect((lastFrame() ?? '').includes('[x] git')).toBe(true);
  // Move down to second option (npm) and toggle it with spacebar
  await writeInput(stdin, '\u001b[B');
  await writeInput(stdin, ' ');
  expect((lastFrame() ?? '').includes('[x] npm')).toBe(true);

  // Move down to "Submit answer" (which is at index 3: git at 0, npm at 1, cargo at 2, Submit answer at 3)
  // Currently we are at index 1 (npm). Move down twice to reach index 3.
  await writeInput(stdin, '\u001b[B');
  await writeInput(stdin, '\u001b[B');
  await writeInput(stdin, '\r');

  expect(JSON.parse(approved || '[]')).toEqual(['git', 'npm']);
});

it.sequential('ApprovalPrompt toggles multi-select options with Enter key', async () => {
  const approval: ApprovalDescriptor = {
    agentName: 'Agent',
    toolName: 'ask_user',
    argumentsText: JSON.stringify({
      questions: [
        {
          question: 'Select tools to use',
          options: [
            { label: 'git', description: 'Version control' },
            { label: 'npm', description: 'JavaScript package manager' },
            { label: 'cargo', description: 'Rust package manager' },
          ],
          is_multi_select: true,
        },
      ],
    }),
    rawInterruption: { type: 'ask_user' },
  };

  const { lastFrame, stdin } = await renderInAct(
    <ApprovalPrompt approval={approval} onApprove={() => {}} onReject={() => {}} onTypeAnswer={() => {}} />,
  );

  // Toggle first option (git) with Enter
  await writeInput(stdin, '\r');
  expect((lastFrame() ?? '').includes('[x] git')).toBe(true);
  // Toggle again to deselect
  await writeInput(stdin, '\r');
  expect((lastFrame() ?? '').includes('[ ] git')).toBe(true);
});

it.sequential('ApprovalPrompt toggles multi-select options with direct number keys', async () => {
  const approval: ApprovalDescriptor = {
    agentName: 'Agent',
    toolName: 'ask_user',
    argumentsText: JSON.stringify({
      questions: [
        {
          question: 'Select tools to use',
          options: [
            { label: 'git', description: 'Version control' },
            { label: 'npm', description: 'JavaScript package manager' },
            { label: 'cargo', description: 'Rust package manager' },
          ],
          is_multi_select: true,
        },
      ],
    }),
    rawInterruption: { type: 'ask_user' },
  };

  const { lastFrame, stdin } = await renderInAct(
    <ApprovalPrompt approval={approval} onApprove={() => {}} onReject={() => {}} onTypeAnswer={() => {}} />,
  );

  // Press 2 to toggle npm
  await writeInput(stdin, '2');
  expect((lastFrame() ?? '').includes('[x] npm')).toBe(true);

  // Press 2 again to deselect npm
  await writeInput(stdin, '2');
  expect((lastFrame() ?? '').includes('[ ] npm')).toBe(true);

  // Press 1 to toggle git
  await writeInput(stdin, '1');
  expect((lastFrame() ?? '').includes('[x] git')).toBe(true);
});

it.sequential('ApprovalPrompt renders question index prefix for multiple questions', async () => {
  const approval: ApprovalDescriptor = {
    agentName: 'Agent',
    toolName: 'ask_user',
    argumentsText: JSON.stringify({
      questions: [
        { question: 'First question', options: [{ label: 'A' }, { label: 'B' }] },
        { question: 'Second question', options: [{ label: 'C' }, { label: 'D' }] },
      ],
    }),
    rawInterruption: { type: 'ask_user' },
  };

  const { lastFrame } = await renderInAct(
    <ApprovalPrompt
      approval={approval}
      onApprove={() => {}}
      onReject={() => {}}
      onTypeAnswer={() => {}}
      currentQuestionIndex={1}
    />,
  );

  const output = lastFrame() ?? '';
  expect(output.includes('Question 2 of 2')).toBe(true);
  expect(output.includes('Second question')).toBe(true);
  // Navigation hints should be in the footer, in the shared MenuFooter shape.
  expect(output.includes('p/n prev/next question')).toBe(true);
});

it.sequential('ApprovalPrompt calls onNavigateQuestion when p or left arrow is pressed', async () => {
  const approval: ApprovalDescriptor = {
    agentName: 'Agent',
    toolName: 'ask_user',
    argumentsText: JSON.stringify({
      questions: [
        { question: 'First question', options: [{ label: 'A' }, { label: 'B' }] },
        { question: 'Second question', options: [{ label: 'C' }, { label: 'D' }] },
      ],
    }),
    rawInterruption: { type: 'ask_user' },
  };

  let navigated: 'prev' | 'next' | undefined;
  const { stdin } = await renderInAct(
    <ApprovalPrompt
      approval={approval}
      onApprove={() => {}}
      onReject={() => {}}
      onTypeAnswer={() => {}}
      onNavigateQuestion={(direction) => {
        navigated = direction;
      }}
      currentQuestionIndex={1}
    />,
  );

  await writeInput(stdin, 'p');
  expect(navigated).toBe('prev');

  navigated = undefined;
  await writeInput(stdin, '\u001b[D'); // left arrow
  expect(navigated).toBe('prev');
});

it.sequential('ApprovalPrompt calls onNavigateQuestion when n or right arrow is pressed', async () => {
  const approval: ApprovalDescriptor = {
    agentName: 'Agent',
    toolName: 'ask_user',
    argumentsText: JSON.stringify({
      questions: [
        { question: 'First question', options: [{ label: 'A' }, { label: 'B' }] },
        { question: 'Second question', options: [{ label: 'C' }, { label: 'D' }] },
      ],
    }),
    rawInterruption: { type: 'ask_user' },
  };

  let navigated: 'prev' | 'next' | undefined;
  const { stdin } = await renderInAct(
    <ApprovalPrompt
      approval={approval}
      onApprove={() => {}}
      onReject={() => {}}
      onTypeAnswer={() => {}}
      onNavigateQuestion={(direction) => {
        navigated = direction;
      }}
      currentQuestionIndex={0}
    />,
  );

  await writeInput(stdin, 'n');
  expect(navigated).toBe('next');

  navigated = undefined;
  await writeInput(stdin, '\u001b[C'); // right arrow
  expect(navigated).toBe('next');
});

it.sequential('ApprovalPrompt does not show navigation items for single question', async () => {
  const approval: ApprovalDescriptor = {
    agentName: 'Agent',
    toolName: 'ask_user',
    argumentsText: JSON.stringify({
      questions: [{ question: 'Single question', options: [{ label: 'A' }, { label: 'B' }] }],
    }),
    rawInterruption: { type: 'ask_user' },
  };

  const { lastFrame } = await renderInAct(
    <ApprovalPrompt approval={approval} onApprove={() => {}} onReject={() => {}} onTypeAnswer={() => {}} />,
  );

  const output = lastFrame() ?? '';
  expect(output.includes('◄ p prev')).toBe(false);
  expect(output.includes('n next ►')).toBe(false);
});

it.sequential('ApprovalPrompt keeps the question UI visible while waiting for a custom answer', async () => {
  let approved: string | undefined;
  const { lastFrame, stdin } = await renderInAct(
    <ApprovalPrompt
      approval={baseApproval}
      onApprove={(answer) => {
        approved = answer;
      }}
      onReject={() => {}}
      onTypeAnswer={() => {}}
      waitingForAskUserAnswer={true}
    />,
  );

  const output = lastFrame() ?? '';
  expect(output.includes('Which option should I use?')).toBe(true);
  expect(output.includes('Type your custom answer in the prompt below')).toBe(true);
  expect(output.includes('Use the safe default')).toBe(true);
  expect(output.includes(ASK_USER_CUSTOM_ANSWER_LABEL)).toBe(true);

  // Pressing Enter should do nothing because key input is suppressed
  await writeInput(stdin, '\r');
  expect(approved).toBe(undefined);
});

it.sequential('ApprovalPrompt dynamically updates description on navigation', async () => {
  const { lastFrame, stdin } = await renderInAct(
    <ApprovalPrompt approval={baseApproval} onApprove={() => {}} onReject={() => {}} onTypeAnswer={() => {}} />,
  );

  // Initially, option 0 is highlighted (safe default description)
  expect((lastFrame() ?? '').includes('Recommended by the agent')).toBe(true);
  expect((lastFrame() ?? '').includes('Optimizes for speed')).toBe(false);

  // Down arrow to option 1 (faster option description)
  await writeInput(stdin, '\u001b[B');
  expect((lastFrame() ?? '').includes('Recommended by the agent')).toBe(false);
  expect((lastFrame() ?? '').includes('Optimizes for speed')).toBe(true);

  // Down arrow to Something else (default custom description)
  await writeInput(stdin, '\u001b[B');
  expect((lastFrame() ?? '').includes('Optimizes for speed')).toBe(false);
  expect((lastFrame() ?? '').includes('Discuss or provide a custom response')).toBe(true);
});

it.sequential('ApprovalPrompt renders network access approval menu options', async () => {
  const approval: ApprovalDescriptor = {
    agentName: 'Sandbox',
    toolName: 'sandbox_network_access',
    argumentsText: 'Allow network access to api.example.com:443?',
    rawInterruption: { type: 'sandbox_network_access' },
  };
  const { lastFrame } = await renderInAct(
    <ApprovalPrompt approval={approval} onApprove={() => {}} onReject={() => {}} />,
  );
  const frame = lastFrame() ?? '';
  expect(frame).toContain('Allow host for this session');
  expect(frame).toContain('Always allow host for this project');
});

it.sequential('ApprovalPrompt sends allow-session for network access approval', async () => {
  let answer: string | undefined;
  const approval: ApprovalDescriptor = {
    agentName: 'Sandbox',
    toolName: 'sandbox_network_access',
    argumentsText: 'Allow network access to api.example.com:443?',
    rawInterruption: { type: 'sandbox_network_access' },
  };
  const { stdin } = await renderInAct(
    <ApprovalPrompt approval={approval} onApprove={(value) => (answer = value)} onReject={() => {}} />,
  );
  // Navigate to 'Allow host for this session' (index 2: Deny [0], Allow once [1], Allow host for this session [2])
  await writeInput(stdin, '\u001B[B');
  await writeInput(stdin, '\u001B[B');
  await writeInput(stdin, '\r');
  expect(answer).toBe('allow-session');
});

it.sequential('ApprovalPrompt sends allow-project for network access approval', async () => {
  let answer: string | undefined;
  const approval: ApprovalDescriptor = {
    agentName: 'Sandbox',
    toolName: 'sandbox_network_access',
    argumentsText: 'Allow network access to api.example.com:443?',
    rawInterruption: { type: 'sandbox_network_access' },
  };
  const { stdin } = await renderInAct(
    <ApprovalPrompt approval={approval} onApprove={(value) => (answer = value)} onReject={() => {}} />,
  );
  // Navigate to 'Always allow host for this project' (index 3)
  for (let idx = 0; idx < 3; idx++) await writeInput(stdin, '\u001B[B');
  await writeInput(stdin, '\r');
  expect(answer).toBe('allow-project');
});

it.sequential('ApprovalPrompt leaves network y and n shortcuts to the stable application owner', async () => {
  let answer: string | undefined;
  let rejected = false;
  const approval: ApprovalDescriptor = {
    agentName: 'Sandbox',
    toolName: 'sandbox_network_access',
    argumentsText: 'Allow network access to api.example.com:443?',
    rawInterruption: { type: 'sandbox_network_access' },
  };

  const { stdin: stdinY } = await renderInAct(
    <ApprovalPrompt approval={approval} onApprove={(value) => (answer = value)} onReject={() => {}} />,
  );
  await writeInput(stdinY, 'y');
  expect(answer).toBeUndefined();

  const { stdin: stdinN } = await renderInAct(
    <ApprovalPrompt approval={approval} onApprove={() => {}} onReject={() => (rejected = true)} />,
  );
  await writeInput(stdinN, 'n');
  expect(rejected).toBe(false);
});

it.sequential('ApprovalPrompt handles malformed shell approval arguments gracefully', async () => {
  const malformedApprovals: ApprovalDescriptor[] = [
    {
      agentName: 'Agent',
      toolName: 'shell',
      argumentsText: '{"invalid": json',
      rawInterruption: { type: 'shell', arguments: '{"invalid": json' },
    },
    {
      agentName: 'Agent',
      toolName: 'shell',
      argumentsText: JSON.stringify([1, 2, 3]),
      rawInterruption: { type: 'shell', arguments: [1, 2, 3] },
    },
    {
      agentName: 'Agent',
      toolName: 'shell',
      argumentsText: JSON.stringify({ sandbox: 'unsandboxed' }), // missing command and commands
      rawInterruption: { type: 'shell', arguments: { sandbox: 'unsandboxed' } },
    },
    {
      agentName: 'Agent',
      toolName: 'shell',
      argumentsText: JSON.stringify({ command: 123, sandbox: 'unsandboxed' }), // invalid type
      rawInterruption: { type: 'shell', arguments: { command: 123 } },
    },
  ];

  for (const approval of malformedApprovals) {
    const { lastFrame } = await renderInAct(
      <ApprovalPrompt approval={approval} onApprove={() => {}} onReject={() => {}} />,
    );
    const output = lastFrame() ?? '';
    expect(output).not.toContain('Agent wants to run in unsandboxed mode:');
    expect(output).not.toContain('Docker Host Control');
  }
});
