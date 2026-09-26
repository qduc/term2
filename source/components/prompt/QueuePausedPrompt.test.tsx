// @ts-expect-error IS_REACT_ACT_ENVIRONMENT is not in globalThis types
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import { it, expect } from 'vitest';
import React, { act } from 'react';
import { renderInAct } from '../../test-helpers/ink-testing.js';
import QueuePausedPrompt from './QueuePausedPrompt.js';

it.sequential('QueuePausedPrompt renders queue count and resume/discard options', async () => {
  const { lastFrame, unmount } = await renderInAct(
    <QueuePausedPrompt queueLength={3} pauseReason="failure" onResume={() => {}} onDiscard={() => {}} />,
  );

  const output = lastFrame() ?? '';
  expect(output.includes('Queue paused: 3 item(s) pending.')).toBe(true);
  expect(output.includes('r resume')).toBe(true);
  expect(output.includes('x discard')).toBe(true);
  expect(output.includes('⏸')).toBe(false);
  act(() => {
    unmount();
  });
});

it.sequential('QueuePausedPrompt shows failure reason when pauseReason is failure', async () => {
  const { lastFrame, unmount } = await renderInAct(
    <QueuePausedPrompt queueLength={1} pauseReason="failure" onResume={() => {}} onDiscard={() => {}} />,
  );

  const output = lastFrame() ?? '';
  expect(output.includes('Last turn failed.')).toBe(true);
  act(() => {
    unmount();
  });
});

it.sequential('QueuePausedPrompt does not show failure reason for manual pause', async () => {
  const { lastFrame, unmount } = await renderInAct(
    <QueuePausedPrompt queueLength={2} pauseReason="manual" onResume={() => {}} onDiscard={() => {}} />,
  );

  const output = lastFrame() ?? '';
  expect(output.includes('Queue paused')).toBe(true);
  expect(output.includes('Last turn failed.')).toBe(false);
  act(() => {
    unmount();
  });
});

it.sequential('QueuePausedPrompt calls onResume on r key', async () => {
  let resumed = false;

  const { stdin, unmount } = await renderInAct(
    <QueuePausedPrompt
      queueLength={1}
      pauseReason="manual"
      onResume={() => {
        resumed = true;
      }}
      onDiscard={() => {}}
    />,
  );

  act(() => {
    stdin.write('r');
  });
  await new Promise((resolve) => setImmediate(resolve));

  expect(resumed).toBe(true);
  act(() => {
    unmount();
  });
});

it.sequential('QueuePausedPrompt calls onDiscard on x key', async () => {
  let discarded = false;

  const { stdin, unmount } = await renderInAct(
    <QueuePausedPrompt
      queueLength={1}
      pauseReason="manual"
      onResume={() => {}}
      onDiscard={() => {
        discarded = true;
      }}
    />,
  );

  act(() => {
    stdin.write('x');
  });
  await new Promise((resolve) => setImmediate(resolve));

  expect(discarded).toBe(true);
  act(() => {
    unmount();
  });
});

it.sequential('QueuePausedPrompt Esc leaves queued messages intact', async () => {
  let discarded = false;
  const { stdin, unmount } = await renderInAct(
    <QueuePausedPrompt
      queueLength={1}
      onResume={() => {}}
      onDiscard={() => {
        discarded = true;
      }}
    />,
  );
  act(() => stdin.write('\u001b'));
  await new Promise((resolve) => setImmediate(resolve));
  expect(discarded).toBe(false);
  act(() => unmount());
});

it.sequential('QueuePausedPrompt uses x as the explicit discard key', async () => {
  let discarded = false;
  const { stdin, unmount } = await renderInAct(
    <QueuePausedPrompt
      queueLength={1}
      onResume={() => {}}
      onDiscard={() => {
        discarded = true;
      }}
    />,
  );
  act(() => stdin.write('x'));
  await new Promise((resolve) => setImmediate(resolve));
  expect(discarded).toBe(true);
  act(() => unmount());
});
