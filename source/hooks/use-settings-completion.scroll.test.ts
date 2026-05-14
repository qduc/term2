import test from 'ava';
import React, { useEffect } from 'react';
import { render } from 'ink-testing-library';
import { InputProvider, useInputContext } from '../context/InputContext.js';
import { useSettingsCompletion } from './use-settings-completion.js';
import { createMockSettingsService } from '../services/settings-service.mock.js';
import { Text } from 'ink';

const settingsService = createMockSettingsService({
  'agent.model': 'gpt-5',
});

const TestComponent = ({ onResults }: { onResults: (results: any) => void }) => {
  const { setInput, setCursorOffset, setMode, setTriggerIndex } = useInputContext();
  const settings = useSettingsCompletion(settingsService);

  useEffect(() => {
    const input = '/settings ';
    setInput(input);
    setCursorOffset(input.length);
    setTriggerIndex('/settings '.length);
    setMode('settings_completion');
  }, [setCursorOffset, setInput, setMode, setTriggerIndex]);

  useEffect(() => {
    onResults(settings);
  }, [onResults, settings]);

  return React.createElement(Text, null, settings.query);
};

test.serial(
  'useSettingsCompletion keeps matches beyond MAX_RESULTS reachable and scrolls selection into view',
  async (t) => {
    let capturedSettings: any;

    render(
      React.createElement(
        InputProvider,
        null,
        React.createElement(TestComponent, {
          onResults: (results: any) => {
            capturedSettings = results;
          },
        }),
      ),
    );

    for (let attempt = 0; attempt < 20; attempt++) {
      if (capturedSettings?.isOpen && capturedSettings.filteredEntries.length > 10) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    t.true(capturedSettings.filteredEntries.length > 10);
    t.is(capturedSettings.selectedIndex, 0);
    t.is(capturedSettings.scrollOffset, 0);

    for (let index = 0; index < 11; index++) {
      capturedSettings.moveDown();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    for (let attempt = 0; attempt < 20; attempt++) {
      if (capturedSettings.selectedIndex > 9 && capturedSettings.scrollOffset > 0) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    t.true(capturedSettings.selectedIndex > 9);
    t.true(capturedSettings.scrollOffset > 0);
  },
);
