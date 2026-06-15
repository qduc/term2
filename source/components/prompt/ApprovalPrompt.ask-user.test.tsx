// @ts-ignore
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import test from 'ava';
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
        options: ['Use the safe default', 'Use the faster option'],
      },
    ],
  }),
  rawInterruption: { type: 'ask_user' },
};

test.serial('ApprovalPrompt renders ask_user question and options', async (t) => {
  const result = await renderInAct(
    <ApprovalPrompt approval={baseApproval} onApprove={() => {}} onReject={() => {}} onTypeAnswer={() => {}} />,
    t,
  );
  const { lastFrame } = result;

  const output = lastFrame() ?? '';
  t.true(output.includes('Which option should I use?'));
  t.true(output.includes('Use the safe default'));
  t.true(output.includes('Use the faster option'));
  t.true(output.includes(ASK_USER_CUSTOM_ANSWER_LABEL));
  t.true(output.includes(ASK_USER_DECLINE_LABEL));
  t.false(output.includes('Allow this action?'));
  t.false(output.includes('Approve'));
});

test.serial('ApprovalPrompt ask_user navigation wraps around menu items', async (t) => {
  const { lastFrame, stdin } = await renderInAct(
    <ApprovalPrompt approval={baseApproval} onApprove={() => {}} onReject={() => {}} onTypeAnswer={() => {}} />,
    t,
  );

  await writeInput(stdin, '\u001b[A');
  t.true((lastFrame() ?? '').includes(`\u276f ${ASK_USER_DECLINE_LABEL}`));

  await writeInput(stdin, '\u001b[B');
  t.true((lastFrame() ?? '').includes('❯ Use the safe default (recommended)'));
});

test.serial('ApprovalPrompt ask_user Enter on an option calls onApprove with the option text', async (t) => {
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
    t,
  );

  await writeInput(stdin, '\r');
  t.is(approved, 'Use the safe default');
});

test.serial('ApprovalPrompt ask_user Enter on Decline to answer calls the decline approval value', async (t) => {
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
    t,
  );

  await writeInput(stdin, '\u001b[A');
  await writeInput(stdin, '\r');

  t.is(approved, ASK_USER_DECLINE_RESULT);
});

test.serial('ApprovalPrompt ask_user Enter on Type custom answer calls onTypeAnswer', async (t) => {
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

  const { stdin } = await renderInAct(
    <ApprovalPrompt
      approval={approval}
      onApprove={() => {}}
      onReject={() => {}}
      onTypeAnswer={() => {
        typedAnswer += 1;
      }}
    />,
    t,
  );

  // Menu: Option 0, Option 1, Type custom answer...(index 2), Decline(index 3)
  await writeInput(stdin, '\u001B[B'); // down to Option 1
  await writeInput(stdin, '\u001B[B'); // down to Type custom answer...
  await writeInput(stdin, '\r');

  t.is(typedAnswer, 1);
});

test.serial('ApprovalPrompt ignores y and n keys for ask_user', async (t) => {
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
    t,
  );

  await writeInput(stdin, 'y');
  await writeInput(stdin, 'n');

  t.is(approveCount, 0);
  t.is(rejectCount, 0);
});

test.serial(
  'ApprovalPrompt ask_user still shows custom answer and decline options without predefined options',
  async (t) => {
    const approval: ApprovalDescriptor = {
      ...baseApproval,
      argumentsText: JSON.stringify({
        questions: [{ question: 'Please answer this question' }],
      }),
    };

    const { lastFrame } = await renderInAct(
      <ApprovalPrompt approval={approval} onApprove={() => {}} onReject={() => {}} onTypeAnswer={() => {}} />,
      t,
    );

    const output = lastFrame() ?? '';
    t.true(output.includes('Please answer this question'));
    t.true(output.includes(ASK_USER_CUSTOM_ANSWER_LABEL));
    t.true(output.includes(ASK_USER_DECLINE_LABEL));
  },
);

test.serial('ApprovalPrompt renders multi-select options with checkboxes', async (t) => {
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

  const { lastFrame } = await renderInAct(
    <ApprovalPrompt approval={approval} onApprove={() => {}} onReject={() => {}} onTypeAnswer={() => {}} />,
    t,
  );

  const output = lastFrame() ?? '';
  t.true(output.includes('[ ] git'));
  t.true(output.includes('[ ] npm'));
  t.true(output.includes('[ ] cargo'));
  t.true(output.includes('[Confirm selections]'));
});

test.serial('ApprovalPrompt toggles multi-select options and submits on Confirm', async (t) => {
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
  const { lastFrame, stdin } = await renderInAct(
    <ApprovalPrompt
      approval={approval}
      onApprove={(answer) => {
        approved = answer;
      }}
      onReject={() => {}}
      onTypeAnswer={() => {}}
    />,
    t,
  );

  // Toggle first option (git)
  await writeInput(stdin, '\r');
  t.true((lastFrame() ?? '').includes('[x] git'));
  // Move down to second option (npm) and toggle it
  await writeInput(stdin, '\u001b[B');
  await writeInput(stdin, '\r');
  t.true((lastFrame() ?? '').includes('[x] npm'));

  // Move down to "[Confirm selections]" (which is at index 3: git at 0, npm at 1, cargo at 2, Confirm selections at 3)
  // Currently we are at index 1 (npm). Move down twice to reach index 3.
  await writeInput(stdin, '\u001b[B');
  await writeInput(stdin, '\u001b[B');
  await writeInput(stdin, '\r');

  t.deepEqual(JSON.parse(approved || '[]'), ['git', 'npm']);
});

test.serial('ApprovalPrompt renders question index prefix for multiple questions', async (t) => {
  const approval: ApprovalDescriptor = {
    agentName: 'Agent',
    toolName: 'ask_user',
    argumentsText: JSON.stringify({
      questions: [{ question: 'First question' }, { question: 'Second question' }],
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
    t,
  );

  const output = lastFrame() ?? '';
  t.true(output.includes('[Question 2/2] Second question'));
});

test.serial(
  'ApprovalPrompt displays custom typing message and suppresses keys when waitingForAskUserAnswer is true',
  async (t) => {
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
      t,
    );

    const output = lastFrame() ?? '';
    t.true(output.includes('Type your custom answer in the prompt below'));
    t.false(output.includes('Use the safe default'));

    // Pressing Enter should do nothing because key input is suppressed
    await writeInput(stdin, '\r');
    t.is(approved, undefined);
  },
);
