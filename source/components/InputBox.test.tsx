import test from 'ava';
import React from 'react';
import { render } from 'ink-testing-library';
import { Box, Text } from 'ink';
import InputBox, { calculateInputWidth } from './InputBox.js';
import { InputProvider, useInputContext } from '../context/InputContext.js';
import type { SlashCommand } from '../slash-commands.js';
import { createMockSettingsService } from '../services/settings-service.mock.js';

// Mock slash commands
const mockSlashCommands: SlashCommand[] = [
  { name: '/clear', description: 'Clear screen', action: () => {} },
  { name: '/quit', description: 'Quit app', action: () => {} },
];

// Default props for InputBox (only the actual props it accepts)
const defaultProps = {
  onSubmit: () => {},
  slashCommands: mockSlashCommands,
  isShellMode: false,

  settingsService: createMockSettingsService(),
  loggingService: {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    security: () => {},
    setCorrelationId: () => {},
    clearCorrelationId: () => {},
  } as any,
  historyService: {
    getMessages: () => [],
    addMessage: () => {},
    clear: () => {},
  } as any,
  onHistoryUp: () => {},
  onHistoryDown: () => {},
};

// Helper to wrap InputBox with InputProvider
const TestInputBox = (props: typeof defaultProps) => (
  <InputProvider>
    <InputBox {...props} />
  </InputProvider>
);

const TestInputBoxWithCursorState = (props: typeof defaultProps) => (
  <InputProvider>
    <CursorState />
    <InputBox {...props} />
  </InputProvider>
);

const CursorState = () => {
  const { cursorOffset } = useInputContext();

  return (
    <Box>
      <Text>Cursor:{cursorOffset}</Text>
    </Box>
  );
};

const getCursorFromFrame = (frame: string | undefined): number | null => {
  const match = frame?.match(/Cursor:(\d+)/);
  return match ? Number(match[1]) : null;
};

const waitForCursor = async (lastFrame: () => string | undefined, predicate: (cursor: number | null) => boolean) => {
  for (let i = 0; i < 20; i++) {
    const cursor = getCursorFromFrame(lastFrame());
    if (predicate(cursor)) return cursor;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return getCursorFromFrame(lastFrame());
};

test('InputBox renders without crashing', (t) => {
  const { lastFrame } = render(<TestInputBox {...defaultProps} />);
  t.truthy(lastFrame());
});

test('InputBox shows the input prompt', (t) => {
  const { lastFrame } = render(<TestInputBox {...defaultProps} />);
  const output = lastFrame();
  t.truthy(output);
  // Should show the prompt character
  t.true(output!.includes('❯'));
});

test('InputBox shows the shell prompt when in shell mode', (t) => {
  const { lastFrame } = render(<TestInputBox {...defaultProps} isShellMode />);
  const output = lastFrame();
  t.truthy(output);
  t.true(output!.includes('$'));
});

test('InputBox can be submitted', (t) => {
  let submitted = false;
  const onSubmit = () => {
    submitted = true;
  };

  render(<TestInputBox {...defaultProps} onSubmit={onSubmit} />);

  // Note: We can't easily test actual submission in this unit test
  // because it requires user input simulation which is complex with MultilineInput
  // This test just verifies the component renders with the onSubmit prop
  t.false(submitted);
  t.pass();
});

test('InputBox accepts slash commands prop', (t) => {
  const customCommands: SlashCommand[] = [{ name: '/test', description: 'Test command', action: () => {} }];

  const { lastFrame } = render(<TestInputBox {...defaultProps} slashCommands={customCommands} />);

  t.truthy(lastFrame());
  t.pass();
});

test('InputBox accepts history callbacks', (t) => {
  let historyUpCalled = false;
  let historyDownCalled = false;

  const onHistoryUp = () => {
    historyUpCalled = true;
  };

  const onHistoryDown = () => {
    historyDownCalled = true;
  };

  render(<TestInputBox {...defaultProps} onHistoryUp={onHistoryUp} onHistoryDown={onHistoryDown} />);

  // Note: We can't easily trigger history navigation in this unit test
  // This test just verifies the component accepts the callbacks
  t.false(historyUpCalled);
  t.false(historyDownCalled);
  t.pass();
});

test('InputBox keeps cursor fixed when left arrow switches model provider', async (t) => {
  const initialValue = '/model gpt-5';
  const { lastFrame, stdin } = render(
    <TestInputBoxWithCursorState
      {...defaultProps}
      slashCommands={[
        ...mockSlashCommands,
        {
          name: '/model',
          description: 'Select model',
          action: () => {},
          completion: { type: 'model', trigger: '/model ' },
        },
      ]}
    />,
  );

  stdin.write(initialValue);
  const beforeCursor = await waitForCursor(lastFrame, (cursor) => cursor !== null && cursor > 0);
  stdin.write('\u001B[D');
  await new Promise((resolve) => setTimeout(resolve, 50));

  t.is(getCursorFromFrame(lastFrame()), beforeCursor, lastFrame());
});

test('calculateInputWidth uses default prompt width for normal mode', (t) => {
  t.is(calculateInputWidth({ terminalColumns: 80, waitingForRejectionReason: false, isShellMode: false }), 74);
});

test('calculateInputWidth uses default prompt width for shell mode', (t) => {
  t.is(calculateInputWidth({ terminalColumns: 80, waitingForRejectionReason: false, isShellMode: true }), 74);
});

test('calculateInputWidth uses rejection prompt width for rejection mode', (t) => {
  t.is(calculateInputWidth({ terminalColumns: 80, waitingForRejectionReason: true, isShellMode: false }), 71);
});
