import test from 'ava';
import React, { act, useEffect } from 'react';
import { render } from 'ink-testing-library';
import { useStdin } from 'ink';
import InputSurgeConfirmationPrompt from './InputSurgeConfirmationPrompt.js';

const flushReactUpdates = async (iterations = 1) => {
  for (let i = 0; i < iterations; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
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

test('InputSurgeConfirmationPrompt renders prompt and choices', (t) => {
  const { lastFrame } = render(
    <InputSurgeConfirmationPrompt reason="Outgoing message count jumped" onConfirm={() => {}} onDecline={() => {}} />,
  );

  const output = lastFrame() ?? '';
  t.true(output.includes('Input Surge Warning: Outgoing message count jumped'));
  t.true(output.includes('Send request anyway?'));
  t.true(output.includes('Send anyway'));
  t.true(output.includes('Cancel'));
});

test('InputSurgeConfirmationPrompt declines on escape', async (t) => {
  let declined = false;
  let inputEmitter: { emit: (event: string, input: string) => void } | null = null;

  const Harness = () => {
    useCaptureInputEmitter((emitter) => {
      inputEmitter = emitter;
    });

    return (
      <InputSurgeConfirmationPrompt
        reason="Outgoing message count jumped"
        onConfirm={() => {}}
        onDecline={() => {
          declined = true;
        }}
      />
    );
  };

  const { lastFrame } = render(<Harness />);

  await flushReactUpdates(2);
  await pressEscape(inputEmitter!);

  t.true((lastFrame() ?? '').includes('Input Surge Warning: Outgoing message count jumped'));
  t.true(declined);
});
