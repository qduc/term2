// @ts-ignore
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import test from 'ava';
import React, { act } from 'react';
import { render } from 'ink-testing-library';
import { useSelection } from './use-selection.js';

const TestComponent = ({
  items,
  onSelection,
  isInactive,
}: {
  items: string[];
  onSelection: (hook: ReturnType<typeof useSelection<string>>) => void;
  isInactive?: (item: string) => boolean;
}) => {
  const selection = useSelection(items, { isInactive });

  // Capture selection synchronously during render, not via useEffect,
  // to avoid the known ink-testing-library race where effects
  // don't run before render() returns (see: vadimdemedes/ink-testing-library#3).
  onSelection(selection);

  return null;
};

test('useSelection - handles up and down wraps', (t) => {
  const items = ['a', 'b', 'c'];
  let currentSelection: ReturnType<typeof useSelection<string>> | undefined;
  let renderer: any;

  act(() => {
    renderer = render(
      React.createElement(TestComponent, {
        items,
        onSelection: (hook) => {
          currentSelection = hook;
        },
      }),
    );
  });

  t.true(currentSelection !== undefined);

  // Initial index should be 0
  t.is(currentSelection!.selectedIndex, 0);

  // Move down goes to 1
  act(() => {
    currentSelection!.moveDown();
  });
  t.is(currentSelection!.selectedIndex, 1);

  // Move down to 2
  act(() => {
    currentSelection!.moveDown();
  });
  t.is(currentSelection!.selectedIndex, 2);

  // Move down wraps to 0
  act(() => {
    currentSelection!.moveDown();
  });
  t.is(currentSelection!.selectedIndex, 0);

  // Move up wraps to 2
  act(() => {
    currentSelection!.moveUp();
  });
  t.is(currentSelection!.selectedIndex, 2);

  act(() => {
    renderer.unmount();
  });
});

test('useSelection - handles home and end keys', (t) => {
  const items = ['a', 'b', 'c', 'd', 'e'];
  let currentSelection: ReturnType<typeof useSelection<string>> | undefined;
  let renderer: any;

  act(() => {
    renderer = render(
      React.createElement(TestComponent, {
        items,
        onSelection: (hook) => {
          currentSelection = hook;
        },
      }),
    );
  });

  t.true(currentSelection !== undefined);

  // Initial index should be 0
  t.is(currentSelection!.selectedIndex, 0);

  // Move to end (index 4)
  act(() => {
    currentSelection!.moveEnd();
  });
  t.is(currentSelection!.selectedIndex, 4);

  // Move to home (index 0)
  act(() => {
    currentSelection!.moveHome();
  });
  t.is(currentSelection!.selectedIndex, 0);

  act(() => {
    renderer.unmount();
  });
});

test('useSelection - pageUp and pageDown navigation', (t) => {
  const items = Array.from({ length: 25 }, (_, i) => `item-${i}`);
  let currentSelection: ReturnType<typeof useSelection<string>> | undefined;
  let renderer: any;

  act(() => {
    renderer = render(
      React.createElement(TestComponent, {
        items,
        onSelection: (hook) => {
          currentSelection = hook;
        },
      }),
    );
  });

  t.true(currentSelection !== undefined);

  // Initial index should be 0
  t.is(currentSelection!.selectedIndex, 0);

  // Page down moves by 10 (index 10)
  act(() => {
    currentSelection!.pageDown();
  });
  t.is(currentSelection!.selectedIndex, 10);

  // Page down moves by 10 (index 20)
  act(() => {
    currentSelection!.pageDown();
  });
  t.is(currentSelection!.selectedIndex, 20);

  // Page down clamped at 24
  act(() => {
    currentSelection!.pageDown();
  });
  t.is(currentSelection!.selectedIndex, 24);

  // Page up moves by 10 (index 14)
  act(() => {
    currentSelection!.pageUp();
  });
  t.is(currentSelection!.selectedIndex, 14);

  // Page up moves by 10 (index 4)
  act(() => {
    currentSelection!.pageUp();
  });
  t.is(currentSelection!.selectedIndex, 4);

  // Page up clamped at 0
  act(() => {
    currentSelection!.pageUp();
  });
  t.is(currentSelection!.selectedIndex, 0);

  act(() => {
    renderer.unmount();
  });
});

test('useSelection - skips inactive items on moveUp and moveDown', (t) => {
  const items = ['a', 'b', 'c', 'd', 'e'];
  const isInactive = (item: string) => item === 'b' || item === 'd';
  let currentSelection: ReturnType<typeof useSelection<string>> | undefined;
  let renderer: any;

  act(() => {
    renderer = render(
      React.createElement(TestComponent, {
        items,
        isInactive,
        onSelection: (hook) => {
          currentSelection = hook;
        },
      }),
    );
  });

  t.true(currentSelection !== undefined);

  // Initial index should adjust to 0 ('a') as it is active
  t.is(currentSelection!.selectedIndex, 0);

  // Move down should skip 'b' (index 1) and land on 'c' (index 2)
  act(() => {
    currentSelection!.moveDown();
  });
  t.is(currentSelection!.selectedIndex, 2);

  // Move down should skip 'd' (index 3) and land on 'e' (index 4)
  act(() => {
    currentSelection!.moveDown();
  });
  t.is(currentSelection!.selectedIndex, 4);

  // Move down should wrap around to 0 ('a')
  act(() => {
    currentSelection!.moveDown();
  });
  t.is(currentSelection!.selectedIndex, 0);

  // Move up should wrap around, skip 'd' (index 3) and land on 'e' (index 4)
  act(() => {
    currentSelection!.moveUp();
  });
  t.is(currentSelection!.selectedIndex, 4);

  // Move up should skip 'd' and land on 'c' (index 2)
  act(() => {
    currentSelection!.moveUp();
  });
  t.is(currentSelection!.selectedIndex, 2);

  act(() => {
    renderer.unmount();
  });
});

test('useSelection - skips inactive items on pageUp, pageDown, moveHome, and moveEnd', (t) => {
  const items = Array.from({ length: 15 }, (_, i) => `item-${i}`);
  // Mark item-10, item-11, item-14 as inactive
  const isInactive = (item: string) => item === 'item-10' || item === 'item-11' || item === 'item-14';
  let currentSelection: ReturnType<typeof useSelection<string>> | undefined;
  let renderer: any;

  act(() => {
    renderer = render(
      React.createElement(TestComponent, {
        items,
        isInactive,
        onSelection: (hook) => {
          currentSelection = hook;
        },
      }),
    );
  });

  t.true(currentSelection !== undefined);
  t.is(currentSelection!.selectedIndex, 0);

  // Move to end: should be item-13 (index 13) since item-14 is inactive
  act(() => {
    currentSelection!.moveEnd();
  });
  t.is(currentSelection!.selectedIndex, 13);

  // Move to home: should be item-0 (index 0)
  act(() => {
    currentSelection!.moveHome();
  });
  t.is(currentSelection!.selectedIndex, 0);

  // Page down by 10 active items from index 0.
  // Active items: item-0 (0), item-1 (1), item-2 (2), item-3 (3), item-4 (4),
  // item-5 (5), item-6 (6), item-7 (7), item-8 (8), item-9 (9), [item-10, item-11 inactive],
  // item-12 (10th active, index 12).
  // So pageDown should land on index 12.
  act(() => {
    currentSelection!.pageDown();
  });
  t.is(currentSelection!.selectedIndex, 12);

  // Page up by 10 active items from index 12.
  // Active items going backward: item-9 (1), item-8 (2), item-7 (3), item-6 (4),
  // item-5 (5), item-4 (6), item-3 (7), item-2 (8), item-1 (9), item-0 (10th active, index 0).
  // So pageUp should land on index 0.
  act(() => {
    currentSelection!.pageUp();
  });
  t.is(currentSelection!.selectedIndex, 0);

  act(() => {
    renderer.unmount();
  });
});
