import test from 'ava';
import React from 'react';
import { render } from 'ink-testing-library';
import ApprovalPrompt from './ApprovalPrompt.js';
import type { ApprovalDescriptor } from '../contracts/conversation.js';
import {
  ASK_USER_CUSTOM_ANSWER_LABEL,
  ASK_USER_DECLINE_LABEL,
  ASK_USER_DECLINE_RESULT,
} from '../tools/ask-user-constants.js';

const flushReactUpdates = async (iterations = 1) => {
  for (let i = 0; i < iterations; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

const writeInput = async (stdin: { write: (input: string) => void }, input: string) => {
  stdin.write(input);
  await flushReactUpdates(2);
};

const baseApproval: ApprovalDescriptor = {
  agentName: 'Agent',
  toolName: 'ask_user',
  argumentsText: JSON.stringify({
    question: 'Which option should I use?',
    options: ['Use the safe default', 'Use the faster option'],
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
      question: 'Which option should I use?',
      options: ['Use the safe default'],
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

  await writeInput(stdin, '\u001B[B');
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
      question: 'Please answer this question',
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
