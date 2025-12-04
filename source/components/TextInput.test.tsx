import test from 'ava';
import React from 'react';
import {render} from 'ink-testing-library';
import {TextInput} from './TextInput.js';

test('onCursorChange callback should not cause re-renders when callback reference changes', t => {
	let renderCount = 0;

	const TestWrapper = () => {
		renderCount++;
		// Create a new callback on each render by using inline arrow function
		return (
			<TextInput
				value="test"
				onChange={() => {}}
				onCursorChange={() => {
					// Callback changes on each render
					// We're testing that this doesn't cause excessive re-renders
				}}
				focus={false}
			/>
		);
	};

	const {rerender} = render(<TestWrapper />);
	const initialRenderCount = renderCount;

	// Force parent re-render with new callback
	rerender(<TestWrapper />);

	// Should only re-render once for the parent update
	// NOT trigger additional re-renders from the onCursorChange effect
	t.is(renderCount, initialRenderCount + 1);
});

test('cursor position updates should not trigger excessive re-renders', t => {
	let renderCount = 0;
	const cursorPositions: number[] = [];

	const TestWrapper = ({value}: {value: string}) => {
		renderCount++;

		return (
			<TextInput
				value={value}
				onChange={() => {}}
				onCursorChange={offset => {
					cursorPositions.push(offset);
				}}
				focus={false}
			/>
		);
	};

	const {rerender} = render(<TestWrapper value="a" />);
	const initialRenderCount = renderCount;

	// Simulate fast typing (multiple value changes)
	rerender(<TestWrapper value="ab" />);
	rerender(<TestWrapper value="abc" />);
	rerender(<TestWrapper value="abcd" />);

	// Should only render once per value change (4 total: initial + 3 updates)
	// NOT multiple renders per value change
	t.is(renderCount, initialRenderCount + 3);

	// Should track cursor positions
	t.true(cursorPositions.length > 0);
});

test('value changes should update cursor offset correctly', t => {
	let cursorOffset = 0;

	const TestWrapper = ({value}: {value: string}) => {
		return (
			<TextInput
				value={value}
				onChange={() => {}}
				onCursorChange={offset => {
					cursorOffset = offset;
				}}
				focus={false}
			/>
		);
	};

	const {rerender} = render(<TestWrapper value="" />);
	t.is(cursorOffset, 0);

	rerender(<TestWrapper value="hello" />);
	// Cursor should not exceed value length
	t.true(cursorOffset <= 5);
});

test('cursorOverride should update cursor position without excessive renders', t => {
	let renderCount = 0;
	let cursorOffset = 0;

	const TestWrapper = ({override}: {override: number | undefined}) => {
		renderCount++;
		return (
			<TextInput
				value="hello world"
				onChange={() => {}}
				onCursorChange={offset => {
					cursorOffset = offset;
				}}
				cursorOverride={override}
				focus={false}
			/>
		);
	};

	const {rerender} = render(<TestWrapper override={undefined} />);
	const initialRenderCount = renderCount;

	// Override to position 5
	rerender(<TestWrapper override={5} />);

	// Should only render once for the override
	t.is(renderCount, initialRenderCount + 1);
	// Cursor should be updated
	t.true(cursorOffset >= 0 && cursorOffset <= 11);
});
