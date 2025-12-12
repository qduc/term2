import test from 'ava';
import React from 'react';
import {render} from 'ink-testing-library';
import {ErrorBoundary} from './ErrorBoundary.js';

// Component that throws an error
const ThrowError: React.FC<{shouldThrow: boolean}> = ({shouldThrow}) => {
	if (shouldThrow) {
		throw new Error('Test error from component');
	}
	return <div>No error</div>;
};

test('ErrorBoundary renders children when there is no error', t => {
	const {lastFrame} = render(
		<ErrorBoundary>
			<ThrowError shouldThrow={false} />
		</ErrorBoundary>,
	);

	t.true(lastFrame()!.includes('No error'));
});

test('ErrorBoundary catches errors and displays fallback UI', t => {
	// Suppress console.error for this test
	const originalError = console.error;
	console.error = () => {};

	const {lastFrame} = render(
		<ErrorBoundary>
			<ThrowError shouldThrow={true} />
		</ErrorBoundary>,
	);

	const output = lastFrame();
	t.true(output!.includes('⚠ Application Error'));
	t.true(output!.includes('Test error from component'));
	t.true(output!.includes('Recovery options:'));
	t.true(output!.includes('/clear'));
	t.true(output!.includes('/quit'));

	// Restore console.error
	console.error = originalError;
});

