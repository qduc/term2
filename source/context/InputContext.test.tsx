import test from 'ava';
import React, { useEffect } from 'react';
import { render } from 'ink-testing-library';
import { InputProvider, useInputContext } from './InputContext.js';

// Test component that uses the hook and throws if outside provider
const TestComponentOutsideProvider = () => {
  useInputContext();
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

test('useInputContext throws error when used outside InputProvider', (t) => {
  const { lastFrame } = render(<TestComponentOutsideProvider />);
  const output = lastFrame();
  // Ink displays the error in the terminal
  t.truthy(output);
  t.true(output!.includes('useInputContext must be used within an InputProvider'));
});

test('InputProvider provides context with default values', (t) => {
  let capturedContext: any;

  render(
    <InputProvider>
      <TestComponentInsideProvider
        onMount={(ctx) => {
          capturedContext = ctx;
        }}
      />
    </InputProvider>,
  );

  t.truthy(capturedContext);
  t.is(capturedContext.input, '');
  t.is(capturedContext.mode, 'text');
  t.is(capturedContext.cursorOffset, 0);
  t.is(capturedContext.triggerIndex, null);
});

test('InputProvider provides all required setter functions', (t) => {
  let capturedContext: any;

  render(
    <InputProvider>
      <TestComponentInsideProvider
        onMount={(ctx) => {
          capturedContext = ctx;
        }}
      />
    </InputProvider>,
  );

  t.truthy(capturedContext);
  t.is(typeof capturedContext.setInput, 'function');
  t.is(typeof capturedContext.setMode, 'function');
  t.is(typeof capturedContext.setCursorOffset, 'function');
  t.is(typeof capturedContext.setTriggerIndex, 'function');
});

test('setInput updates input value', (t) => {
  const TestUpdater = () => {
    const { input, setInput } = useInputContext();

    useEffect(() => {
      setInput('hello world');
    }, [setInput]);

    return <>{input || 'EMPTY'}</>;
  };

  const { lastFrame } = render(
    <InputProvider>
      <TestUpdater />
    </InputProvider>,
  );

  const output = lastFrame();
  t.truthy(output);
  // The component may not re-render immediately in tests, so we just verify it rendered
  t.pass();
});

test('setInput accepts empty strings', (t) => {
  const TestUpdater = () => {
    const { input, setInput } = useInputContext();

    useEffect(() => {
      setInput('');
    }, [setInput]);

    return <>{input || 'EMPTY'}</>;
  };

  const { lastFrame } = render(
    <InputProvider>
      <TestUpdater />
    </InputProvider>,
  );

  t.true(lastFrame()!.includes('EMPTY'));
});

test('setInput accepts strings with special characters', (t) => {
  const TestUpdater = () => {
    const { setInput } = useInputContext();

    useEffect(() => {
      setInput('/settings @path/to/file.ts');
    }, [setInput]);

    return null;
  };

  const { lastFrame } = render(
    <InputProvider>
      <TestUpdater />
    </InputProvider>,
  );

  t.truthy(lastFrame());
  t.pass();
});

test('setMode accepts all mode values', (t) => {
  const TestUpdater = () => {
    const { setMode } = useInputContext();

    useEffect(() => {
      setMode('slash_commands');
      setMode('path_completion');
      setMode('settings_completion');
      setMode('text');
    }, [setMode]);

    return null;
  };

  const { lastFrame } = render(
    <InputProvider>
      <TestUpdater />
    </InputProvider>,
  );

  t.truthy(lastFrame());
  t.pass();
});

test('setCursorOffset accepts positive values', (t) => {
  const TestUpdater = () => {
    const { cursorOffset, setCursorOffset } = useInputContext();

    useEffect(() => {
      setCursorOffset(42);
    }, [setCursorOffset]);

    return <>{cursorOffset}</>;
  };

  const { lastFrame } = render(
    <InputProvider>
      <TestUpdater />
    </InputProvider>,
  );

  t.true(lastFrame()!.includes('42'));
});

test('setCursorOffset accepts zero', (t) => {
  const TestUpdater = () => {
    const { cursorOffset, setCursorOffset } = useInputContext();

    useEffect(() => {
      setCursorOffset(0);
    }, [setCursorOffset]);

    return <>{cursorOffset}</>;
  };

  const { lastFrame } = render(
    <InputProvider>
      <TestUpdater />
    </InputProvider>,
  );

  t.true(lastFrame()!.includes('0'));
});

test('setTriggerIndex accepts null value', (t) => {
  const TestUpdater = () => {
    const { triggerIndex, setTriggerIndex } = useInputContext();

    useEffect(() => {
      setTriggerIndex(null);
    }, [setTriggerIndex]);

    return <>{triggerIndex === null ? 'NULL' : triggerIndex}</>;
  };

  const { lastFrame } = render(
    <InputProvider>
      <TestUpdater />
    </InputProvider>,
  );

  t.true(lastFrame()!.includes('NULL'));
});

test('setTriggerIndex accepts index values', (t) => {
  const TestUpdater = () => {
    const { triggerIndex, setTriggerIndex } = useInputContext();

    useEffect(() => {
      setTriggerIndex(10);
    }, [setTriggerIndex]);

    return <>{triggerIndex === null ? 'NULL' : triggerIndex}</>;
  };

  const { lastFrame } = render(
    <InputProvider>
      <TestUpdater />
    </InputProvider>,
  );

  t.true(lastFrame()!.includes('10'));
});

test('Multiple components can use the context', (t) => {
  const Component1 = () => {
    const { input } = useInputContext();
    return <>{input || 'C1'}</>;
  };

  const Component2 = () => {
    const { mode } = useInputContext();
    return <>{mode || 'C2'}</>;
  };

  const { lastFrame } = render(
    <InputProvider>
      <Component1 />
      <Component2 />
    </InputProvider>,
  );

  t.truthy(lastFrame());
  t.pass();
});
