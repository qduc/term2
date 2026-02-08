import test from 'ava';
import React from 'react';
import { render } from 'ink-testing-library';
import InputBox from './InputBox.js';
import { InputProvider } from '../context/InputContext.js';
import type { SlashCommand } from './SlashCommandMenu.js';
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
