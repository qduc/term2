import test from 'ava';
import React, { useEffect } from 'react';
import { render } from 'ink-testing-library';
import { InputProvider, useInputContext } from '../context/InputContext.js';
import { SETTINGS_TRIGGER } from '../components/Input/triggers.js';
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
    const input = SETTINGS_TRIGGER;
    setInput(input);
    setCursorOffset(input.length);
    setTriggerIndex(SETTINGS_TRIGGER.length);
    setMode('settings_completion');
  }, [setCursorOffset, setInput, setMode, setTriggerIndex]);

  useEffect(() => {
    onResults(settings);
  }, [onResults, settings]);

  return React.createElement(Text, null, settings.query);
};

const SearchComponent = ({ onResults }: { onResults: (results: any) => void }) => {
  const { setInput, setCursorOffset, setMode, setTriggerIndex } = useInputContext();
  const settings = useSettingsCompletion(settingsService);

  useEffect(() => {
    const input = `${SETTINGS_TRIGGER}timeout`;
    setInput(input);
    setCursorOffset(input.length);
    setTriggerIndex(SETTINGS_TRIGGER.length);
    setMode('settings_completion');
  }, [setCursorOffset, setInput, setMode, setTriggerIndex]);

  useEffect(() => {
    onResults(settings);
  }, [onResults, settings]);

  return React.createElement(Text, null, settings.query);
};

test.serial('useSettingsCompletion filters settings by active task tab and switches tabs', async (t) => {
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
    if (capturedSettings?.isOpen && capturedSettings.filteredEntries.length > 0) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  t.is(capturedSettings.activeCategoryId, 'model');
  t.true(capturedSettings.filteredEntries.some((item: any) => item.key === 'agent.model'));
  t.false(capturedSettings.filteredEntries.some((item: any) => item.key === 'shell.timeout'));
  t.is(capturedSettings.selectedIndex, 0);
  t.is(capturedSettings.scrollOffset, 0);

  capturedSettings.switchCategory('next');

  for (let attempt = 0; attempt < 20; attempt++) {
    if (capturedSettings.activeCategoryId === 'approvals') {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  t.is(capturedSettings.activeCategoryId, 'approvals');
  t.true(capturedSettings.filteredEntries.some((item: any) => item.key === 'agent.autoApproveModel'));
  t.false(capturedSettings.filteredEntries.some((item: any) => item.key === 'agent.model'));
  t.is(capturedSettings.selectedIndex, 0);
  t.is(capturedSettings.scrollOffset, 0);
});

test.serial('useSettingsCompletion searches all task tabs when query is present', async (t) => {
  let capturedSettings: any;

  render(
    React.createElement(
      InputProvider,
      null,
      React.createElement(SearchComponent, {
        onResults: (results: any) => {
          capturedSettings = results;
        },
      }),
    ),
  );

  for (let attempt = 0; attempt < 20; attempt++) {
    if (capturedSettings?.isOpen && capturedSettings.filteredEntries.length > 0) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  t.is(capturedSettings.activeCategoryId, 'model');
  t.true(capturedSettings.isSearchingAll);
  t.true(capturedSettings.filteredEntries.some((item: any) => item.key === 'shell.timeout'));
});
