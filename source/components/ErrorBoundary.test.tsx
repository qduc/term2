// @ts-ignore
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import test from 'ava';
import React from 'react';
import { renderInAct } from '../test-helpers/ink-testing.js';
import { ErrorBoundary } from './ErrorBoundary.js';

// Component that throws an error
const ThrowError: React.FC<{ shouldThrow: boolean }> = ({ shouldThrow }) => {
  if (shouldThrow) {
    throw new Error('Test error from component');
  }
  return <div>No error</div>;
};

test.serial('ErrorBoundary renders children when there is no error', async (t) => {
  const { lastFrame } = await renderInAct(
    <ErrorBoundary>
      <ThrowError shouldThrow={false} />
    </ErrorBoundary>,
    t,
  );

  t.true(lastFrame()!.includes('No error'));
});

test.serial('ErrorBoundary catches errors and displays fallback UI', async (t) => {
  // Suppress console.error for this test
  const originalError = console.error;
  console.error = () => {};

  try {
    const { lastFrame } = await renderInAct(
      <ErrorBoundary>
        <ThrowError shouldThrow={true} />
      </ErrorBoundary>,
      t,
    );

    const output = lastFrame();
    t.true(output!.includes('⚠ Application Error'));
    t.true(output!.includes('Test error from component'));
    t.true(output!.includes('Recovery options:'));
    t.true(output!.includes('/clear'));
    t.true(output!.includes('/quit'));
  } finally {
    console.error = originalError;
  }
});
