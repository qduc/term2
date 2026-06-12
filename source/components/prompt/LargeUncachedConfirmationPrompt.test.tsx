import test from 'ava';
import React, { act, useEffect } from 'react';
import { render } from 'ink-testing-library';
import { useStdin } from 'ink';
import LargeUncachedConfirmationPrompt from './LargeUncachedConfirmationPrompt.js';

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

test('LargeUncachedConfirmationPrompt renders prompt and choices', (t) => {
  const { lastFrame } = render(
    <LargeUncachedConfirmationPrompt usage={{ prompt_tokens: 72_100 }} onConfirm={() => {}} onDecline={() => {}} />,
  );

  const output = lastFrame() ?? '';
  t.true(output.includes('Send 72,100 tokens anyway?'));
  t.true(output.includes('may miss prompt cache'));
  t.true(output.includes('Send'));
  t.true(output.includes('Cancel'));
});

test('LargeUncachedConfirmationPrompt declines on escape', async (t) => {
  let declined = false;
  let inputEmitter: { emit: (event: string, input: string) => void } | null = null;

  const Harness = () => {
    useCaptureInputEmitter((emitter) => {
      inputEmitter = emitter;
    });

    return (
      <LargeUncachedConfirmationPrompt
        usage={{ prompt_tokens: 72_100 }}
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

  t.true((lastFrame() ?? '').includes('Send 72,100 tokens anyway?'));
  t.true(declined);
});
