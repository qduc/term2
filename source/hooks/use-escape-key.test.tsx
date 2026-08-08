// @ts-expect-error IS_REACT_ACT_ENVIRONMENT is not in globalThis types
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import { it, expect } from 'vitest';
import React, { act, useEffect, useState } from 'react';
import { useEscapeKey } from './use-escape-key.js';
import { Box, Text, useInput, useStdin } from 'ink';
import { renderInAct } from '../test-helpers/ink-testing.js';

const TestComponent = ({
  initialValue = 'some text',
  onEscape,
  turnInFlight = false,
}: {
  initialValue?: string;
  onEscape?: () => boolean;
  turnInFlight?: boolean;
}) => {
  const [value, onChange] = useState(initialValue);

  const { escHintVisible } = useEscapeKey({
    value,
    onChange,
    onEscape,
    turnInFlight,
  });

  return (
    <Box flexDirection="column">
      <Text>Value: {value}</Text>
      {escHintVisible && <Text>HINT</Text>}
    </Box>
  );
};

const flushReactUpdates = async (iterations = 1) => {
  await act(async () => {
    for (let i = 0; i < iterations; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  });
};

const renderAndFlush = async (element: React.ReactElement) => {
  const result = await renderInAct(element);
  await flushReactUpdates(10);
  return result;
};

const useCaptureInputEmitter = (setEmitter: (emitter: any) => void) => {
  const stdin = useStdin() as any;

  useEffect(() => {
    setEmitter(stdin.internal_eventEmitter);
  }, [setEmitter, stdin]);
};

const pressEscape = async (emitter: { emit: (event: string, input: string) => void }) => {
  await act(async () => {
    emitter.emit('input', '\u001B');
  });

  await flushReactUpdates(3);
};

it.sequential('pressing ESC once shows hint, second time clears input', async () => {
  let inputEmitter: { emit: (event: string, input: string) => void } | null = null;

  const TestHarness = () => {
    useCaptureInputEmitter((emitter) => {
      inputEmitter = emitter;
    });
    return <TestComponent />;
  };

  const { lastFrame } = await renderAndFlush(<TestHarness />);

  // Initial state
  expect(lastFrame()!.includes('Value: some text')).toBe(true);
  expect(lastFrame()!.includes('HINT')).toBe(false);

  // First ESC
  await pressEscape(inputEmitter!);

  expect(lastFrame()!.includes('HINT'), 'Hint should be visible after first ESC').toBe(true);
  expect(lastFrame()!.includes('Value: some text'), 'Value should still be there').toBe(true);

  // Second ESC
  await pressEscape(inputEmitter!);

  const finalFrame = lastFrame()!;
  expect(finalFrame.includes('HINT'), 'Hint should be hidden after second ESC').toBe(false);
  expect(finalFrame.includes('Value:'), 'Label should be present').toBe(true);
  expect(finalFrame.includes('some text'), 'Value should be cleared').toBe(false);
});

it.sequential('clears non-empty text during an in-flight turn', async () => {
  let inputEmitter: { emit: (event: string, input: string) => void } | null = null;
  const TestHarness = () => {
    useCaptureInputEmitter((emitter) => {
      inputEmitter = emitter;
    });
    return <TestComponent turnInFlight />;
  };

  const { lastFrame } = await renderAndFlush(<TestHarness />);
  await pressEscape(inputEmitter!);
  await pressEscape(inputEmitter!);
  expect(lastFrame()!.includes('some text')).toBe(false);
});

it.sequential('defers empty-buffer Escape to the app interrupt during a turn', async () => {
  let inputEmitter: { emit: (event: string, input: string) => void } | null = null;
  const TestHarness = () => {
    useCaptureInputEmitter((emitter) => {
      inputEmitter = emitter;
    });
    return <TestComponent initialValue="" turnInFlight />;
  };

  const { lastFrame } = await renderAndFlush(<TestHarness />);
  await pressEscape(inputEmitter!);
  expect(lastFrame()!.includes('HINT')).toBe(false);
});

it.sequential('onEscape callback consuming ESC prevents hint', async () => {
  let inputEmitter: { emit: (event: string, input: string) => void } | null = null;
  let escConsumed = false;

  const TestHarness = () => {
    useCaptureInputEmitter((emitter) => {
      inputEmitter = emitter;
    });
    return (
      <TestComponent
        onEscape={() => {
          escConsumed = true;
          return true;
        }}
      />
    );
  };

  const { lastFrame } = await renderAndFlush(<TestHarness />);

  await pressEscape(inputEmitter!);

  expect(escConsumed).toBe(true);
  expect(lastFrame()!.includes('HINT')).toBe(false);
});
