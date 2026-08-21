// @ts-expect-error IS_REACT_ACT_ENVIRONMENT is not in globalThis types
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import { it, expect } from 'vitest';
import React, { act } from 'react';
import { renderInAct } from '../../test-helpers/ink-testing.js';
import ModeSwitchConfirmationPrompt from './ModeSwitchConfirmationPrompt.js';

const flushReactUpdates = async (iterations = 3) => {
  await act(async () => {
    for (let i = 0; i < iterations; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  });
};

it.sequential('ModeSwitchConfirmationPrompt renders prompt and choices with No selected by default', async () => {
  const { lastFrame, unmount } = await renderInAct(
    <ModeSwitchConfirmationPrompt modeLabel="Lite" onConfirm={() => {}} onDecline={() => {}} />,
  );

  const output = lastFrame() ?? '';
  expect(output.includes('Switching to Lite mode requires clearing the current session.')).toBe(true);
  expect(output.includes('Clear session and switch to Lite mode?')).toBe(true);
  expect(output.includes('Yes')).toBe(true);
  expect(output.includes('❯ No')).toBe(true); // Default selection is No for safety
  act(() => {
    unmount();
  });
});

it.sequential('ModeSwitchConfirmationPrompt renders disabling prompt when targetValue is false', async () => {
  const { lastFrame, unmount } = await renderInAct(
    <ModeSwitchConfirmationPrompt modeLabel="Lite" targetValue={false} onConfirm={() => {}} onDecline={() => {}} />,
  );

  const output = lastFrame() ?? '';
  expect(output.includes('Disabling Lite mode requires clearing the current session.')).toBe(true);
  expect(output.includes('Clear session and disable Lite mode?')).toBe(true);
  expect(output.includes('❯ No')).toBe(true);
  act(() => {
    unmount();
  });
});

it.sequential('ModeSwitchConfirmationPrompt declines on return key by default (safety default)', async () => {
  let declined = false;
  let confirmed = false;

  const { stdin, unmount } = await renderInAct(
    <ModeSwitchConfirmationPrompt
      modeLabel="Lite"
      onConfirm={() => {
        confirmed = true;
      }}
      onDecline={() => {
        declined = true;
      }}
    />,
  );

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

it.sequential('ModeSwitchConfirmationPrompt confirms on y input', async () => {
  let confirmed = false;

  const { stdin, unmount } = await renderInAct(
    <ModeSwitchConfirmationPrompt
      modeLabel="Lite"
      onConfirm={() => {
        confirmed = true;
      }}
      onDecline={() => {}}
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

it.sequential('ModeSwitchConfirmationPrompt declines on n input', async () => {
  let declined = false;

  const { stdin, unmount } = await renderInAct(
    <ModeSwitchConfirmationPrompt
      modeLabel="Lite"
      onConfirm={() => {}}
      onDecline={() => {
        declined = true;
      }}
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

it.sequential('ModeSwitchConfirmationPrompt cancels on escape key', async () => {
  let cancelled = false;

  const { stdin, unmount } = await renderInAct(
    <ModeSwitchConfirmationPrompt
      modeLabel="Lite"
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

it.sequential('ModeSwitchConfirmationPrompt navigates with up arrow and confirms on return', async () => {
  let confirmed = false;

  const { stdin, unmount, lastFrame } = await renderInAct(
    <ModeSwitchConfirmationPrompt
      modeLabel="Orchestrator"
      onConfirm={() => {
        confirmed = true;
      }}
      onDecline={() => {}}
    />,
  );

  await act(async () => {
    stdin.write('\u001B[A'); // Up arrow
  });
  await flushReactUpdates();

  const output = lastFrame() ?? '';
  expect(output.includes('❯ Yes')).toBe(true);

  await act(async () => {
    stdin.write('\r');
  });
  await flushReactUpdates();

  expect(confirmed).toBe(true);
  act(() => {
    unmount();
  });
});
