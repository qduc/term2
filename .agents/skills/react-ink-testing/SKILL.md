---
name: react-ink-testing
description: >
  Complete guide for writing unit tests for React Ink CLI components using
  ink-testing-library and Jest/Vitest. Use this skill whenever the user wants
  to write, fix, or improve tests for any Ink component, CLI app built with Ink,
  or hooks like useInput, useFocus, useApp, or useStdin. Also trigger when the
  user mentions "test my CLI", "ink component test", "test terminal output",
  "mock keyboard input in tests", or "test Ink hooks". Even if they just say
  "add tests to this Ink component" or paste an Ink component and ask about
  testing — use this skill.
---

# React Ink Unit Testing

React Ink uses its own renderer (not the DOM), so standard React Testing Library
**does not work**. Always use `ink-testing-library` instead.

## Setup

```bash
npm install --save-dev ink-testing-library jest
# or with Vitest:
npm install --save-dev ink-testing-library vitest
```

For ESM projects (Ink v4+ is ESM-only):
```json
// package.json
{
  "type": "module",
  "scripts": {
    "test": "node --experimental-vm-modules node_modules/.bin/jest"
  }
}
```

```js
// jest.config.js  (for ESM)
export default {
  testEnvironment: 'node',
  transform: {},
  extensionsToTreatAsEsm: ['.jsx', '.tsx'],
};
```

---

## Core API of ink-testing-library

```js
import { render } from 'ink-testing-library';

const { lastFrame, frames, rerender, unmount, stdin, stdout, stderr } =
  render(<MyComponent />);
```

| Return value | What it is |
|---|---|
| `lastFrame()` | The latest terminal output string |
| `frames` | Array of all rendered strings (every re-render) |
| `rerender(<El />)` | Re-render with new props or a different component |
| `unmount()` | Unmount the component |
| `stdin.write(str)` | Simulate keyboard input |
| `stdout.lastFrame()` | Same as `lastFrame()` |
| `stdout.frames` | Same as `frames` |
| `stderr.lastFrame()` | Last frame written to stderr |
| `stderr.frames` | All stderr frames |

---

## Patterns by Use Case

### 1. Basic render & output assertion

```js
import React from 'react';
import { Text } from 'ink';
import { render } from 'ink-testing-library';

const Greeting = ({ name }) => <Text>Hello, {name}!</Text>;

test('renders greeting', () => {
  const { lastFrame } = render(<Greeting name="World" />);
  expect(lastFrame()).toBe('Hello, World!');
});
```

### 2. Testing prop changes (rerender)

```js
test('updates when props change', () => {
  const Counter = ({ count }) => <Text>Count: {count}</Text>;

  const { lastFrame, rerender } = render(<Counter count={0} />);
  expect(lastFrame()).toBe('Count: 0');

  rerender(<Counter count={5} />);
  expect(lastFrame()).toBe('Count: 5');
});
```

### 3. Testing keyboard input with useInput

```js
import { useState } from 'react';
import { useInput, Text } from 'ink';

const InputTracker = () => {
  const [key, setKey] = useState('none');
  useInput((input, k) => {
    if (k.upArrow) setKey('up');
    else if (k.downArrow) setKey('down');
    else setKey(input);
  });
  return <Text>Last: {key}</Text>;
};

test('handles arrow key input', () => {
  const { lastFrame, stdin } = render(<InputTracker />);
  
  stdin.write('\u001B[A'); // up arrow escape code
  expect(lastFrame()).toBe('Last: up');

  stdin.write('\u001B[B'); // down arrow escape code
  expect(lastFrame()).toBe('Last: down');
});

test('handles character input', () => {
  const { lastFrame, stdin } = render(<InputTracker />);
  stdin.write('q');
  expect(lastFrame()).toBe('Last: q');
});
```

**Common escape codes:**

| Key | Escape code |
|---|---|
| Up arrow | `\u001B[A` |
| Down arrow | `\u001B[B` |
| Right arrow | `\u001B[C` |
| Left arrow | `\u001B[D` |
| Enter | `\r` |
| Escape | `\u001B` |
| Backspace | `\u007F` |
| Tab | `\t` |
| Ctrl+C | `\x03` |

### 4. Testing async state (useEffect, timers)

Ink renders synchronously in test mode, but async side effects need a tick:

```js
import { useState, useEffect } from 'react';
import { Text } from 'ink';

const AsyncLoader = () => {
  const [data, setData] = useState('loading...');
  useEffect(() => {
    Promise.resolve('done').then(setData);
  }, []);
  return <Text>{data}</Text>;
};

test('shows loading then data', async () => {
  const { lastFrame } = render(<AsyncLoader />);
  expect(lastFrame()).toBe('loading...');

  // Let the promise microtask queue flush
  await Promise.resolve();
  expect(lastFrame()).toBe('done');
});
```

For timer-based async:
```js
// With jest fake timers
jest.useFakeTimers();
test('progress updates over time', () => {
  const { lastFrame } = render(<ProgressBar />);
  expect(lastFrame()).toContain('0%');
  
  jest.advanceTimersByTime(1000);
  expect(lastFrame()).toContain('50%');
  
  jest.advanceTimersByTime(1000);
  expect(lastFrame()).toContain('100%');
});
```

### 5. Testing multi-frame animations

Use `frames` to assert the full animation sequence:

```js
test('animates through all states', () => {
  const { frames, stdin } = render(<WizardFlow />);
  
  expect(frames[0]).toContain('Step 1');
  
  stdin.write('\r'); // press Enter
  expect(frames[frames.length - 1]).toContain('Step 2');
});
```

### 6. Testing exit / useApp

```js
import { useApp, Text } from 'ink';

const Quitter = () => {
  const { exit } = useApp();
  useInput(input => { if (input === 'q') exit(); });
  return <Text>Press q to quit</Text>;
};

test('unmounts when q is pressed', () => {
  const { lastFrame, stdin, unmount } = render(<Quitter />);
  expect(lastFrame()).toBe('Press q to quit');
  stdin.write('q');
  // After exit(), the component should unmount cleanly
  // Check your component no longer renders error output
  expect(stderr.lastFrame()).toBeUndefined();
});
```

### 7. Testing stderr output

```js
import { useStderr, Text } from 'ink';

const ErrorBoundaryComp = ({ fail }) => {
  const { write } = useStderr();
  useEffect(() => { if (fail) write('Something went wrong\n'); }, [fail]);
  return <Text>Status: {fail ? 'error' : 'ok'}</Text>;
};

test('writes error to stderr', () => {
  const { stderr } = render(<ErrorBoundaryComp fail={true} />);
  expect(stderr.lastFrame()).toContain('Something went wrong');
});
```

### 8. Testing focus (useFocus)

```js
import { useFocus, Text, Box } from 'ink';

const FocusableItem = ({ label }) => {
  const { isFocused } = useFocus();
  return (
    <Box>
      <Text color={isFocused ? 'green' : 'white'}>{label}</Text>
    </Box>
  );
};

test('renders focused state', () => {
  // Wrap in a parent that enables focus management
  const App = () => (
    <>
      <FocusableItem label="Item A" />
      <FocusableItem label="Item B" />
    </>
  );
  
  const { lastFrame, stdin } = render(<App />);
  // Tab cycles focus
  stdin.write('\t');
  expect(lastFrame()).toContain('Item A'); // focus may add ANSI color codes
});
```

### 9. Mocking external dependencies

```js
// Mock a module that makes network calls
jest.mock('./api', () => ({
  fetchData: jest.fn().mockResolvedValue({ result: 'mocked' }),
}));

import { fetchData } from './api';

test('shows fetched data', async () => {
  const { lastFrame } = render(<DataFetcher />);
  expect(lastFrame()).toContain('loading');
  
  await Promise.resolve(); // flush microtasks
  expect(lastFrame()).toContain('mocked');
  expect(fetchData).toHaveBeenCalledTimes(1);
});
```

---

## Common Gotchas

**ANSI color codes in assertions:** `lastFrame()` includes ANSI escape codes for colors. Use `.toContain()` for text matching rather than exact string equality when colors are involved. Or strip ANSI with `strip-ansi` if you need exact matching.

```js
import stripAnsi from 'strip-ansi';
expect(stripAnsi(lastFrame())).toBe('Hello World');
```

**Ink v4 is ESM-only:** Requires `"type": "module"` in `package.json` and a Jest ESM setup (or use Vitest which handles ESM natively).

**`useEffect` timing:** In ink-testing-library, the initial render is synchronous. `useLayoutEffect` runs synchronously, but `useEffect` callbacks that trigger state updates won't be visible until the next microtask tick.

**`useInput` conflicts:** Multiple `useInput` hooks in the same tree both receive all input. Design components to handle this deliberately.

**Concurrent mode:** If you enable Ink's concurrent mode (`<App experimental_concurrent/>`), some tests may need `act()` from React to flush updates:
```js
import { act } from 'react';
act(() => { stdin.write('x'); });
expect(lastFrame()).toContain('x pressed');
```

---

## File Structure Recommendation

Co-locate tests with the components they test:

```
src/
├── components/
│   ├── SelectMenu.jsx
│   ├── SelectMenu.test.jsx    ← preferred
│   └── __tests__/
│       └── SelectMenu.test.jsx  ← also fine
```

---

## Test Template (copy-paste starter)

```js
import React from 'react';
import { render } from 'ink-testing-library';
import { MyComponent } from './MyComponent.jsx';

describe('MyComponent', () => {
  test('renders initial state', () => {
    const { lastFrame } = render(<MyComponent />);
    expect(lastFrame()).toContain('expected text');
  });

  test('responds to keyboard input', () => {
    const { lastFrame, stdin } = render(<MyComponent />);
    stdin.write('a');
    expect(lastFrame()).toContain('a');
  });

  test('updates on prop change', () => {
    const { lastFrame, rerender } = render(<MyComponent value="first" />);
    expect(lastFrame()).toContain('first');
    rerender(<MyComponent value="second" />);
    expect(lastFrame()).toContain('second');
  });

  test('cleans up on unmount', () => {
    const { unmount, stderr } = render(<MyComponent />);
    unmount();
    expect(stderr.lastFrame()).toBeUndefined();
  });
});
```

---

## Further Reference

See `references/escape-codes.md` for a full table of terminal escape codes
for simulating special keys via `stdin.write()`.
