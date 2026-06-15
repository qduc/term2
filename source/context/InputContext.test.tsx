// @ts-ignore
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import test from 'ava';
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

test.serial('useInputContext throws error when used outside InputProvider', async (t) => {
  // Suppress console.error for React hook warnings/errors
  const originalError = console.error;
  console.error = () => {};

  await renderInAct(<TestComponentOutsideProvider />, t);
  t.truthy(thrownError);
  t.is(thrownError!.message, 'useInputContext must be used within an InputProvider');

  console.error = originalError;
});

test.serial('InputProvider provides context with default values', async (t) => {
  let capturedContext: any;

  await renderInAct(
    <InputProvider>
      <TestComponentInsideProvider
        onMount={(ctx) => {
          capturedContext = ctx;
        }}
      />
    </InputProvider>,
    t,
  );

  t.truthy(capturedContext);
  t.is(capturedContext.input, '');
  t.is(capturedContext.mode, 'text');
  t.is(capturedContext.cursorOffset, 0);
  t.is(capturedContext.triggerIndex, null);
});

test.serial('InputProvider provides all required setter functions', async (t) => {
  let capturedContext: any;

  await renderInAct(
    <InputProvider>
      <TestComponentInsideProvider
        onMount={(ctx) => {
          capturedContext = ctx;
        }}
      />
    </InputProvider>,
    t,
  );

  t.truthy(capturedContext);
  t.is(typeof capturedContext.setInput, 'function');
  t.is(typeof capturedContext.setMode, 'function');
  t.is(typeof capturedContext.setCursorOffset, 'function');
  t.is(typeof capturedContext.setTriggerIndex, 'function');
});

test.serial('setInput updates input value', async (t) => {
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
    t,
  );

  await flushReactUpdates(5);

  const output = lastFrame();
  t.truthy(output);
  t.true(output!.includes('hello world'));
});

test.serial('setInput accepts empty strings', async (t) => {
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
    t,
  );

  await flushReactUpdates(5);

  t.true(lastFrame()!.includes('EMPTY'));
});

test.serial('setInput accepts strings with special characters', async (t) => {
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
    t,
  );

  await flushReactUpdates(5);

  t.truthy(lastFrame());
  t.true(lastFrame()!.includes('/settings @path/to/file.ts'));
});

test.serial('setMode accepts all mode values', async (t) => {
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
    t,
  );

  await flushReactUpdates(5);

  t.truthy(lastFrame());
  t.true(lastFrame()!.includes('text'));
});

test.serial('setCursorOffset accepts positive values', async (t) => {
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
    t,
  );

  await flushReactUpdates(5);

  t.true(lastFrame()!.includes('42'));
});

test.serial('setCursorOffset accepts zero', async (t) => {
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
    t,
  );

  await flushReactUpdates(5);

  t.true(lastFrame()!.includes('0'));
});

test.serial('setTriggerIndex accepts null value', async (t) => {
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
    t,
  );

  await flushReactUpdates(5);

  t.true(lastFrame()!.includes('NULL'));
});

test.serial('setTriggerIndex accepts index values', async (t) => {
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
    t,
  );

  await flushReactUpdates(5);

  t.true(lastFrame()!.includes('10'));
});

test.serial('Multiple components can use the context', async (t) => {
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
    t,
  );

  t.truthy(lastFrame());
  t.pass();
});
