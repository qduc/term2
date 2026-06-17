// @ts-ignore
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import { it, expect } from 'vitest';
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

it.sequential('ErrorBoundary renders children when there is no error', async () => {
  const { lastFrame } = await renderInAct(
    <ErrorBoundary>
      <ThrowError shouldThrow={false} />
    </ErrorBoundary>,
  );

  expect(lastFrame()!.includes('No error')).toBe(true);
});

it.sequential('ErrorBoundary catches errors and displays fallback UI', async () => {
  // Suppress console.error for this test
  const originalError = console.error;
  console.error = () => {};

  try {
    const { lastFrame } = await renderInAct(
      <ErrorBoundary>
        <ThrowError shouldThrow={true} />
      </ErrorBoundary>,
    );

    const output = lastFrame();
    expect(output!.includes('⚠ Application Error')).toBe(true);
    expect(output!.includes('Test error from component')).toBe(true);
    expect(output!.includes('Recovery options:')).toBe(true);
    expect(output!.includes('/clear')).toBe(true);
    expect(output!.includes('/quit')).toBe(true);
  } finally {
    console.error = originalError;
  }
});
