// @ts-ignore
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import test from 'ava';
import React, { act } from 'react';
import { render } from 'ink-testing-library';
import ApprovalPrompt from './ApprovalPrompt.js';
import type { ApprovalDescriptor } from '../../contracts/conversation.js';
import {
  ASK_USER_CUSTOM_ANSWER_LABEL,
  ASK_USER_DECLINE_LABEL,
  ASK_USER_DECLINE_RESULT,
} from '../../tools/agent/ask-user-constants.js';

const flushReactUpdates = async (iterations = 1) => {
  await act(async () => {
    for (let i = 0; i < iterations; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  });
};

const writeInput = async (stdin: { write: (input: string) => void }, input: string) => {
  await act(async () => {
    stdin.write(input);
  });
  await flushReactUpdates(2);
};

const baseApproval: ApprovalDescriptor = {
  agentName: 'Agent',
  toolName: 'ask_user',
  argumentsText: JSON.stringify({
    questions: [
      {
        question: 'Which option should I use?',
        options: ['Use the safe default', 'Use the faster option'],
      },
    ],
  }),
  rawInterruption: { type: 'ask_user' },
};

test('ApprovalPrompt renders ask_user question and options', (t) => {
  const { lastFrame, unmount } = render(
    <ApprovalPrompt approval={baseApproval} onApprove={() => {}} onReject={() => {}} onTypeAnswer={() => {}} />,
  );

  const output = lastFrame() ?? '';
  t.true(output.includes('Which option should I use?'));
  t.true(output.includes('Use the safe default'));
  t.true(output.includes('Use the faster option'));
  t.true(output.includes(ASK_USER_CUSTOM_ANSWER_LABEL));
  t.true(output.includes(ASK_USER_DECLINE_LABEL));
  t.false(output.includes('Allow this action?'));
  t.false(output.includes('Approve'));
  unmount();
});

test('ApprovalPrompt ask_user navigation wraps around menu items', async (t) => {
  const { lastFrame, stdin, unmount } = render(
    <ApprovalPrompt approval={baseApproval} onApprove={() => {}} onReject={() => {}} onTypeAnswer={() => {}} />,
  );

  await writeInput(stdin, '\u001B[A');
  t.true((lastFrame() ?? '').includes(`❯ ${ASK_USER_DECLINE_LABEL}`));

  await writeInput(stdin, '\u001B[B');
  t.true((lastFrame() ?? '').includes('❯ Use the safe default (recommended)'));
  unmount();
});

test('ApprovalPrompt ask_user Enter on an option calls onApprove with the option text', async (t) => {
  let approved: string | undefined;
  const { stdin, unmount } = render(
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
  t.is(approved, 'Use the safe default');
  unmount();
});

test('ApprovalPrompt ask_user Enter on Decline to answer calls the decline approval value', async (t) => {
  let approved: string | undefined;
  const { stdin, unmount } = render(
    <ApprovalPrompt
      approval={baseApproval}
      onApprove={(answer) => {
        approved = answer;
      }}
      onReject={() => {}}
      onTypeAnswer={() => {}}
    />,
  );

  await writeInput(stdin, '\u001B[A');
  await writeInput(stdin, '\r');

  t.is(approved, ASK_USER_DECLINE_RESULT);
  unmount();
});

test('ApprovalPrompt ask_user Enter on Type custom answer calls onTypeAnswer', async (t) => {
  let typedAnswer = 0;
  const approval: ApprovalDescriptor = {
    ...baseApproval,
    argumentsText: JSON.stringify({
      questions: [
        {
          question: 'Which option should I use?',
          options: ['Use the safe default', 'Use the faster option'],
        },
      ],
    }),
  };

  const { stdin, unmount } = render(
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

  t.is(typedAnswer, 1);
  unmount();
});

test('ApprovalPrompt ignores y and n keys for ask_user', async (t) => {
  let approveCount = 0;
  let rejectCount = 0;
  const { stdin, unmount } = render(
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

  t.is(approveCount, 0);
  t.is(rejectCount, 0);
  unmount();
});

test('ApprovalPrompt ask_user still shows custom answer and decline options without predefined options', (t) => {
  const approval: ApprovalDescriptor = {
    ...baseApproval,
    argumentsText: JSON.stringify({
      questions: [{ question: 'Please answer this question' }],
    }),
  };

  const { lastFrame, unmount } = render(
    <ApprovalPrompt approval={approval} onApprove={() => {}} onReject={() => {}} onTypeAnswer={() => {}} />,
  );

  const output = lastFrame() ?? '';
  t.true(output.includes('Please answer this question'));
  t.true(output.includes(ASK_USER_CUSTOM_ANSWER_LABEL));
  t.true(output.includes(ASK_USER_DECLINE_LABEL));
  unmount();
});

test('ApprovalPrompt renders multi-select options with checkboxes', (t) => {
  const approval: ApprovalDescriptor = {
    agentName: 'Agent',
    toolName: 'ask_user',
    argumentsText: JSON.stringify({
      questions: [
        {
          question: 'Select tools to use',
          options: ['git', 'npm', 'cargo'],
          is_multi_select: true,
        },
      ],
    }),
    rawInterruption: { type: 'ask_user' },
  };

  const { lastFrame, unmount } = render(
    <ApprovalPrompt approval={approval} onApprove={() => {}} onReject={() => {}} onTypeAnswer={() => {}} />,
  );

  const output = lastFrame() ?? '';
  t.true(output.includes('[ ] git'));
  t.true(output.includes('[ ] npm'));
  t.true(output.includes('[ ] cargo'));
  t.true(output.includes('[Confirm selections]'));
  unmount();
});

test('ApprovalPrompt toggles multi-select options and submits on Confirm', async (t) => {
  const approval: ApprovalDescriptor = {
    agentName: 'Agent',
    toolName: 'ask_user',
    argumentsText: JSON.stringify({
      questions: [
        {
          question: 'Select tools to use',
          options: ['git', 'npm', 'cargo'],
          is_multi_select: true,
        },
      ],
    }),
    rawInterruption: { type: 'ask_user' },
  };

  let approved: string | undefined;
  const { lastFrame, stdin, unmount } = render(
    <ApprovalPrompt
      approval={approval}
      onApprove={(answer) => {
        approved = answer;
      }}
      onReject={() => {}}
      onTypeAnswer={() => {}}
    />,
  );

  // Toggle first option (git)
  await writeInput(stdin, '\r');
  t.true((lastFrame() ?? '').includes('[x] git'));

  // Move down to second option (npm) and toggle it
  await writeInput(stdin, '\u001B[B');
  await writeInput(stdin, '\r');
  t.true((lastFrame() ?? '').includes('[x] npm'));

  // Move down to "[Confirm selections]" (which is at index 3: git at 0, npm at 1, cargo at 2, Confirm selections at 3)
  // Currently we are at index 1 (npm). Move down twice to reach index 3.
  await writeInput(stdin, '\u001B[B');
  await writeInput(stdin, '\u001B[B');
  await writeInput(stdin, '\r');

  t.deepEqual(JSON.parse(approved || '[]'), ['git', 'npm']);
  unmount();
});

test('ApprovalPrompt renders question index prefix for multiple questions', (t) => {
  const approval: ApprovalDescriptor = {
    agentName: 'Agent',
    toolName: 'ask_user',
    argumentsText: JSON.stringify({
      questions: [{ question: 'First question' }, { question: 'Second question' }],
    }),
    rawInterruption: { type: 'ask_user' },
  };

  const { lastFrame, unmount } = render(
    <ApprovalPrompt
      approval={approval}
      onApprove={() => {}}
      onReject={() => {}}
      onTypeAnswer={() => {}}
      currentQuestionIndex={1}
    />,
  );

  const output = lastFrame() ?? '';
  t.true(output.includes('[Question 2/2] Second question'));
  unmount();
});

test('ApprovalPrompt displays custom typing message and suppresses keys when waitingForAskUserAnswer is true', async (t) => {
  let approved: string | undefined;
  const { lastFrame, stdin, unmount } = render(
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
  t.true(output.includes('Type your custom answer in the prompt below'));
  t.false(output.includes('Use the safe default'));

  // Pressing Enter should do nothing because key input is suppressed
  await writeInput(stdin, '\r');
  t.is(approved, undefined);
  unmount();
});
