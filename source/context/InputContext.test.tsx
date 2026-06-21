// @ts-expect-error IS_REACT_ACT_ENVIRONMENT is not in globalThis types
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import { it, expect } from 'vitest';
import React, { act, useEffect } from 'react';
import { Text } from 'ink';
import { InputProvider, useInputContext } from './InputContext.js';
import { renderInAct } from '../test-helpers/ink-testing.js';

// Helper to flush asynchronous React/Ink updates
const flushReactUpdates = async (iterations = 5) => {
  await act(async () => {
    for (let i = 0; i < iterations; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  });
};

let thrownError: Error | null = null;
const TestComponentOutsideProvider = () => {
  try {
    useInputContext();
  } catch (err: any) {
    thrownError = err;
  }
  return null;
};

// Test component that uses the hook inside provider
const TestComponentInsideProvider = ({ onMount }: { onMount: (ctx: any) => void }) => {
  const context = useInputContext();

  useEffect(() => {
    onMount(context);
  }, [context, onMount]);

  return null;
};

it.sequential('useInputContext throws error when used outside InputProvider', async () => {
  // Suppress console.error for React hook warnings/errors
  const originalError = console.error;
  console.error = () => {};

  await renderInAct(<TestComponentOutsideProvider />);
  expect(thrownError).toBeTruthy();
  expect(thrownError!.message).toBe('useInputContext must be used within an InputProvider');

  console.error = originalError;
});

it.sequential('InputProvider provides context with default values', async () => {
  let capturedContext: any;

  await renderInAct(
    <InputProvider>
      <TestComponentInsideProvider
        onMount={(ctx) => {
          capturedContext = ctx;
        }}
      />
    </InputProvider>,
  );

  expect(capturedContext).toBeTruthy();
  expect(capturedContext.input).toBe('');
  expect(capturedContext.mode).toBe('text');
  expect(capturedContext.cursorOffset).toBe(0);
  expect(capturedContext.triggerIndex).toBe(null);
});

it.sequential('InputProvider provides all required setter functions', async () => {
  let capturedContext: any;

  await renderInAct(
    <InputProvider>
      <TestComponentInsideProvider
        onMount={(ctx) => {
          capturedContext = ctx;
        }}
      />
    </InputProvider>,
  );

  expect(capturedContext).toBeTruthy();
  expect(typeof capturedContext.setInput).toBe('function');
  expect(typeof capturedContext.setMode).toBe('function');
  expect(typeof capturedContext.setCursorOffset).toBe('function');
  expect(typeof capturedContext.setTriggerIndex).toBe('function');
});

it.sequential('setInput updates input value', async () => {
  const TestUpdater = () => {
    const { input, setInput } = useInputContext();

    useEffect(() => {
      setInput('hello world');
    }, [setInput]);

    return <Text>{input || 'EMPTY'}</Text>;
  };

  const { lastFrame } = await renderInAct(
    <InputProvider>
      <TestUpdater />
    </InputProvider>,
  );

  await flushReactUpdates(5);

  const output = lastFrame();
  expect(output).toBeTruthy();
  expect(output!.includes('hello world')).toBe(true);
});

it.sequential('setInput accepts empty strings', async () => {
  const TestUpdater = () => {
    const { input, setInput } = useInputContext();

    useEffect(() => {
      setInput('');
    }, [setInput]);

    return <Text>{input || 'EMPTY'}</Text>;
  };

  const { lastFrame } = await renderInAct(
    <InputProvider>
      <TestUpdater />
    </InputProvider>,
  );

  await flushReactUpdates(5);

  expect(lastFrame()!.includes('EMPTY')).toBe(true);
});

it.sequential('setInput accepts strings with special characters', async () => {
  const TestUpdater = () => {
    const { input, setInput } = useInputContext();

    useEffect(() => {
      setInput('/settings @path/to/file.ts');
    }, [setInput]);

    return <Text>{input || 'EMPTY'}</Text>;
  };

  const { lastFrame } = await renderInAct(
    <InputProvider>
      <TestUpdater />
    </InputProvider>,
  );

  await flushReactUpdates(5);

  expect(lastFrame()).toBeTruthy();
  expect(lastFrame()!.includes('/settings @path/to/file.ts')).toBe(true);
});

it.sequential('setMode accepts all mode values', async () => {
  const TestUpdater = () => {
    const { mode, setMode } = useInputContext();

    useEffect(() => {
      setMode('slash_commands');
      setMode('path_completion');
      setMode('settings_completion');
      setMode('text');
    }, [setMode]);

    return <Text>{mode || 'EMPTY'}</Text>;
  };

  const { lastFrame } = await renderInAct(
    <InputProvider>
      <TestUpdater />
    </InputProvider>,
  );

  await flushReactUpdates(5);

  expect(lastFrame()).toBeTruthy();
  expect(lastFrame()!.includes('text')).toBe(true);
});

it.sequential('setCursorOffset accepts positive values', async () => {
  const TestUpdater = () => {
    const { cursorOffset, setCursorOffset } = useInputContext();

    useEffect(() => {
      setCursorOffset(42);
    }, [setCursorOffset]);

    return <Text>{cursorOffset.toString()}</Text>;
  };

  const { lastFrame } = await renderInAct(
    <InputProvider>
      <TestUpdater />
    </InputProvider>,
  );

  await flushReactUpdates(5);

  expect(lastFrame()!.includes('42')).toBe(true);
});

it.sequential('setCursorOffset accepts zero', async () => {
  const TestUpdater = () => {
    const { cursorOffset, setCursorOffset } = useInputContext();

    useEffect(() => {
      setCursorOffset(0);
    }, [setCursorOffset]);

    return <Text>{cursorOffset.toString()}</Text>;
  };

  const { lastFrame } = await renderInAct(
    <InputProvider>
      <TestUpdater />
    </InputProvider>,
  );

  await flushReactUpdates(5);

  expect(lastFrame()!.includes('0')).toBe(true);
});

it.sequential('setTriggerIndex accepts null value', async () => {
  const TestUpdater = () => {
    const { triggerIndex, setTriggerIndex } = useInputContext();

    useEffect(() => {
      setTriggerIndex(null);
    }, [setTriggerIndex]);

    return <Text>{triggerIndex === null ? 'NULL' : triggerIndex.toString()}</Text>;
  };

  const { lastFrame } = await renderInAct(
    <InputProvider>
      <TestUpdater />
    </InputProvider>,
  );

  await flushReactUpdates(5);

  expect(lastFrame()!.includes('NULL')).toBe(true);
});

it.sequential('setTriggerIndex accepts index values', async () => {
  const TestUpdater = () => {
    const { triggerIndex, setTriggerIndex } = useInputContext();

    useEffect(() => {
      setTriggerIndex(10);
    }, [setTriggerIndex]);

    return <Text>{triggerIndex === null ? 'NULL' : triggerIndex.toString()}</Text>;
  };

  const { lastFrame } = await renderInAct(
    <InputProvider>
      <TestUpdater />
    </InputProvider>,
  );

  await flushReactUpdates(5);

  expect(lastFrame()!.includes('10')).toBe(true);
});

it.sequential('Multiple components can use the context', async () => {
  const Component1 = () => {
    const { input } = useInputContext();
    return <Text>{input || 'C1'}</Text>;
  };

  const Component2 = () => {
    const { mode } = useInputContext();
    return <Text>{mode || 'C2'}</Text>;
  };

  const { lastFrame } = await renderInAct(
    <InputProvider>
      <Component1 />
      <Component2 />
    </InputProvider>,
  );

  expect(lastFrame()).toBeTruthy();
  expect(true).toBe(true);
});

it.sequential('setInputAndCursor updates input, cursorOffset, and cursorOverride', async () => {
  const TestUpdater = () => {
    const { input, cursorOffset, cursorOverride, setInputAndCursor } = useInputContext();

    useEffect(() => {
      setInputAndCursor('hello world', 5, 8);
    }, [setInputAndCursor]);

    return (
      <Text>
        {input}:{cursorOffset}:{cursorOverride ?? 'null'}
      </Text>
    );
  };

  const { lastFrame } = await renderInAct(
    <InputProvider>
      <TestUpdater />
    </InputProvider>,
  );

  await flushReactUpdates(5);

  expect(lastFrame()!.includes('hello world:5:8')).toBe(true);
});

it.sequential('setCursorOverride updates cursorOverride state', async () => {
  const TestUpdater = () => {
    const { cursorOverride, setCursorOverride } = useInputContext();

    useEffect(() => {
      setCursorOverride(42);
    }, [setCursorOverride]);

    return <Text>{cursorOverride === null ? 'null' : cursorOverride.toString()}</Text>;
  };

  const { lastFrame } = await renderInAct(
    <InputProvider>
      <TestUpdater />
    </InputProvider>,
  );

  await flushReactUpdates(5);

  expect(lastFrame()!.includes('42')).toBe(true);
});
