import test from 'ava';
import React from 'react';
import { render } from 'ink-testing-library';
import { useSelection } from './use-selection.js';

const TestComponent = ({
  items,
  onSelection,
}: {
  items: string[];
  onSelection: (hook: ReturnType<typeof useSelection<string>>) => void;
}) => {
  const selection = useSelection(items);

  // Capture selection synchronously during render, not via useEffect,
  // to avoid the known ink-testing-library race where effects
  // don't run before render() returns (see: vadimdemedes/ink-testing-library#3).
  onSelection(selection);

  return null;
};

test.serial('useSelection - handles up and down wraps', (t) => {
  const items = ['a', 'b', 'c'];
  let currentSelection: ReturnType<typeof useSelection<string>> | undefined;

  render(
    React.createElement(TestComponent, {
      items,
      onSelection: (hook) => {
        currentSelection = hook;
      },
    }),
  );

  t.true(currentSelection !== undefined);

  // Initial index should be 0
  t.is(currentSelection!.selectedIndex, 0);

  // Move down goes to 1
  currentSelection!.moveDown();
  t.is(currentSelection!.selectedIndex, 1);

  // Move down to 2
  currentSelection!.moveDown();
  t.is(currentSelection!.selectedIndex, 2);

  // Move down wraps to 0
  currentSelection!.moveDown();
  t.is(currentSelection!.selectedIndex, 0);

  // Move up wraps to 2
  currentSelection!.moveUp();
  t.is(currentSelection!.selectedIndex, 2);
});

test.serial('useSelection - handles home and end keys', (t) => {
  const items = ['a', 'b', 'c', 'd', 'e'];
  let currentSelection: ReturnType<typeof useSelection<string>> | undefined;

  render(
    React.createElement(TestComponent, {
      items,
      onSelection: (hook) => {
        currentSelection = hook;
      },
    }),
  );

  t.true(currentSelection !== undefined);

  // Initial index should be 0
  t.is(currentSelection!.selectedIndex, 0);

  // Move to end (index 4)
  currentSelection!.moveEnd();
  t.is(currentSelection!.selectedIndex, 4);

  // Move to home (index 0)
  currentSelection!.moveHome();
  t.is(currentSelection!.selectedIndex, 0);
});

test.serial('useSelection - pageUp and pageDown navigation', (t) => {
  const items = Array.from({ length: 25 }, (_, i) => `item-${i}`);
  let currentSelection: ReturnType<typeof useSelection<string>> | undefined;

  render(
    React.createElement(TestComponent, {
      items,
      onSelection: (hook) => {
        currentSelection = hook;
      },
    }),
  );

  t.true(currentSelection !== undefined);

  // Initial index should be 0
  t.is(currentSelection!.selectedIndex, 0);

  // Page down moves by 10 (index 10)
  currentSelection!.pageDown();
  t.is(currentSelection!.selectedIndex, 10);

  // Page down moves by 10 (index 20)
  currentSelection!.pageDown();
  t.is(currentSelection!.selectedIndex, 20);

  // Page down clamped at 24
  currentSelection!.pageDown();
  t.is(currentSelection!.selectedIndex, 24);

  // Page up moves by 10 (index 14)
  currentSelection!.pageUp();
  t.is(currentSelection!.selectedIndex, 14);

  // Page up moves by 10 (index 4)
  currentSelection!.pageUp();
  t.is(currentSelection!.selectedIndex, 4);

  // Page up clamped at 0
  currentSelection!.pageUp();
  t.is(currentSelection!.selectedIndex, 0);
});
