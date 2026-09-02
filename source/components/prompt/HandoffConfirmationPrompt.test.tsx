// @ts-expect-error IS_REACT_ACT_ENVIRONMENT is not in globalThis types
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import { it, expect } from 'vitest';
import React, { act } from 'react';
import { renderInAct } from '../../test-helpers/ink-testing.js';
import HandoffConfirmationPrompt from './HandoffConfirmationPrompt.js';

const flushReactUpdates = async (iterations = 3) => {
  await act(async () => {
    for (let i = 0; i < iterations; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  });
};

it.sequential('HandoffConfirmationPrompt renders question and choices with Yes selected by default', async () => {
  const { lastFrame, unmount } = await renderInAct(
    <HandoffConfirmationPrompt onConfirm={() => {}} onDecline={() => {}} onCancel={() => {}} />,
  );

  const output = lastFrame() ?? '';
  expect(output.includes('📋 Change model?')).toBe(true);
  expect(output.includes('❯ Yes')).toBe(true); // Default selection is Yes
  expect(output.includes('No')).toBe(true);

  act(() => {
    unmount();
  });
});

it.sequential('HandoffConfirmationPrompt confirms on y input', async () => {
  let confirmed = false;

  const { stdin, unmount } = await renderInAct(
    <HandoffConfirmationPrompt
      onConfirm={() => {
        confirmed = true;
      }}
      onDecline={() => {}}
      onCancel={() => {}}
    />,
  );

  await act(async () => {
    stdin.write('y');
  });
  await flushReactUpdates();

  expect(confirmed).toBe(true);
  act(() => {
    unmount();
  });
});

it.sequential('HandoffConfirmationPrompt declines on n input', async () => {
  let declined = false;

  const { stdin, unmount } = await renderInAct(
    <HandoffConfirmationPrompt
      onConfirm={() => {}}
      onDecline={() => {
        declined = true;
      }}
      onCancel={() => {}}
    />,
  );

  await act(async () => {
    stdin.write('n');
  });
  await flushReactUpdates();

  expect(declined).toBe(true);
  act(() => {
    unmount();
  });
});

it.sequential('HandoffConfirmationPrompt confirms on return with the default Yes selection', async () => {
  let confirmed = false;

  const { stdin, unmount } = await renderInAct(
    <HandoffConfirmationPrompt
      onConfirm={() => {
        confirmed = true;
      }}
      onDecline={() => {}}
      onCancel={() => {}}
    />,
  );

  await act(async () => {
    stdin.write('\r');
  });
  await flushReactUpdates();

  expect(confirmed).toBe(true);
  act(() => {
    unmount();
  });
});

it.sequential('HandoffConfirmationPrompt declines on return after moving down to No', async () => {
  let declined = false;
  let confirmed = false;

  const { stdin, lastFrame, unmount } = await renderInAct(
    <HandoffConfirmationPrompt
      onConfirm={() => {
        confirmed = true;
      }}
      onDecline={() => {
        declined = true;
      }}
      onCancel={() => {}}
    />,
  );

  await act(async () => {
    stdin.write('\u001B[B'); // Down arrow
  });
  await flushReactUpdates();

  const output = lastFrame() ?? '';
  expect(output.includes('❯ No')).toBe(true);

  await act(async () => {
    stdin.write('\r');
  });
  await flushReactUpdates();

  expect(confirmed).toBe(false);
  expect(declined).toBe(true);
  act(() => {
    unmount();
  });
});

it.sequential('HandoffConfirmationPrompt cancels on escape key', async () => {
  let cancelled = false;

  const { stdin, unmount } = await renderInAct(
    <HandoffConfirmationPrompt
      onConfirm={() => {}}
      onDecline={() => {}}
      onCancel={() => {
        cancelled = true;
      }}
    />,
  );

  await act(async () => {
    stdin.write('\u001B');
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  await flushReactUpdates();

  expect(cancelled).toBe(true);
  act(() => {
    unmount();
  });
});
