// @ts-ignore
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import test from 'ava';
import React, { act } from 'react';
import { render } from 'ink-testing-library';
import { ErrorBoundary } from './ErrorBoundary.js';

// Component that throws an error
const ThrowError: React.FC<{ shouldThrow: boolean }> = ({ shouldThrow }) => {
  if (shouldThrow) {
    throw new Error('Test error from component');
  }
  return <div>No error</div>;
};

test('ErrorBoundary renders children when there is no error', async (t) => {
  let lastFrame!: () => string | undefined;
  let unmount!: () => void;

  await act(async () => {
    const result = render(
      <ErrorBoundary>
        <ThrowError shouldThrow={false} />
      </ErrorBoundary>,
    );
    lastFrame = result.lastFrame;
    unmount = result.unmount;
  });

  t.true(lastFrame()!.includes('No error'));
  unmount();
});

test('ErrorBoundary catches errors and displays fallback UI', async (t) => {
  // Suppress console.error for this test
  const originalError = console.error;
  console.error = () => {};

  let lastFrame!: () => string | undefined;
  let unmount!: () => void;

  await act(async () => {
    const result = render(
      <ErrorBoundary>
        <ThrowError shouldThrow={true} />
      </ErrorBoundary>,
    );
    lastFrame = result.lastFrame;
    unmount = result.unmount;
  });

  const output = lastFrame();
  t.true(output!.includes('⚠ Application Error'));
  t.true(output!.includes('Test error from component'));
  t.true(output!.includes('Recovery options:'));
  t.true(output!.includes('/clear'));
  t.true(output!.includes('/quit'));

  unmount();

  // Restore console.error
  console.error = originalError;
});
