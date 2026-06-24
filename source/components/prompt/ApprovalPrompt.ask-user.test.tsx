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
import { renderInAct } from '../../test-helpers/ink-testing.js';

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
  expect(output.includes('Use the safe default')).toBe(true);
  expect(output.includes('Recommended by the agent')).toBe(true);
  expect(output.includes('Use the faster option')).toBe(true);
  expect(output.includes('Optimizes for speed')).toBe(false);
  expect(output.includes(ASK_USER_CUSTOM_ANSWER_LABEL)).toBe(true);
  expect(output.includes(ASK_USER_DECLINE_LABEL)).toBe(true);
  expect(output.includes('Allow this action?')).toBe(false);
  expect(output.includes('Approve')).toBe(false);
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
  expect((lastFrame() ?? '').includes(`\u276f ${ASK_USER_DECLINE_LABEL}`)).toBe(true);

  await writeInput(stdin, '\u001b[B');
  expect((lastFrame() ?? '').includes('❯ Use the safe default (recommended)')).toBe(true);
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

it.sequential('ApprovalPrompt ask_user Enter on Decline to answer calls the decline approval value', async () => {
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

  await writeInput(stdin, '\u001b[A');
  await writeInput(stdin, '\r');

  expect(approved).toBe(ASK_USER_DECLINE_RESULT);
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

  // Menu: Option 0, Option 1, Type custom answer...(index 2), Decline(index 3)
  await writeInput(stdin, '\u001B[B'); // down to Option 1
  await writeInput(stdin, '\u001B[B'); // down to Type custom answer...
  await writeInput(stdin, '\r');

  expect(typedAnswer).toBe(1);
});

it.sequential('ApprovalPrompt ignores y and n keys for ask_user', async () => {
  let approveCount = 0;
  let rejectCount = 0;
  const { stdin } = await renderInAct(
    <ApprovalPrompt
      approval={baseApproval}
      onApprove={() => {
        approveCount += 1;
      }}
      onReject={() => {
        rejectCount += 1;
      }}
      onTypeAnswer={() => {}}
    />,
  );

  await writeInput(stdin, 'y');
  await writeInput(stdin, 'n');

  expect(approveCount).toBe(0);
  expect(rejectCount).toBe(0);
});

it.sequential(
  'ApprovalPrompt ask_user still shows custom answer and decline options without predefined options',
  async () => {
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
    expect(output.includes(ASK_USER_CUSTOM_ANSWER_LABEL)).toBe(true);
    expect(output.includes(ASK_USER_DECLINE_LABEL)).toBe(true);
  },
);

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
  expect(output.includes('[Question 2/2] Second question')).toBe(true);
  // Navigation items should be present for multiple questions
  expect(output.includes('◀ Previous question')).toBe(true);
  expect(output.includes('Next question ▶')).toBe(true);
});

it.sequential('ApprovalPrompt calls onNavigateQuestion when Previous is selected', async () => {
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

  // Navigate to "Previous question" (last item before "Next question")
  // Menu: C (0), D (1), Custom answer (2), Decline (3), Previous (4), Next (5)
  await writeInput(stdin, '\u001b[B'); // D
  await writeInput(stdin, '\u001b[B'); // Custom answer
  await writeInput(stdin, '\u001b[B'); // Decline
  await writeInput(stdin, '\u001b[B'); // Previous
  await writeInput(stdin, '\r');

  expect(navigated).toBe('prev');
});

it.sequential('ApprovalPrompt calls onNavigateQuestion when Next is selected', async () => {
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

  // Navigate to "Next question" (last item)
  // Menu: A (0), B (1), Custom answer (2), Decline (3), Previous (4), Next (5)
  await writeInput(stdin, '\u001b[B'); // B
  await writeInput(stdin, '\u001b[B'); // Custom answer
  await writeInput(stdin, '\u001b[B'); // Decline
  await writeInput(stdin, '\u001b[B'); // Previous
  await writeInput(stdin, '\u001b[B'); // Next
  await writeInput(stdin, '\r');

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
  expect(output.includes('◀ Previous question')).toBe(false);
  expect(output.includes('Next question ▶')).toBe(false);
});

it.sequential(
  'ApprovalPrompt displays custom typing message and suppresses keys when waitingForAskUserAnswer is true',
  async () => {
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
    expect(output.includes('Type your custom answer in the prompt below')).toBe(true);
    expect(output.includes('Use the safe default')).toBe(false);

    // Pressing Enter should do nothing because key input is suppressed
    await writeInput(stdin, '\r');
    expect(approved).toBe(undefined);
  },
);

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

  // Down arrow to Custom Answer (default custom description)
  await writeInput(stdin, '\u001b[B');
  expect((lastFrame() ?? '').includes('Optimizes for speed')).toBe(false);
  expect((lastFrame() ?? '').includes('Type a custom write-in response.')).toBe(true);
});
