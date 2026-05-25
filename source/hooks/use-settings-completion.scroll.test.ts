// @ts-ignore
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import test from 'ava';
import React, { useEffect, act } from 'react';
import { render } from 'ink-testing-library';
import { InputProvider, useInputContext } from '../context/InputContext.js';
import { SETTINGS_TRIGGER } from '../components/Input/triggers.js';
import { useSettingsCompletion, getSettingCategory } from './use-settings-completion.js';
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

test('useSettingsCompletion filters settings by active task tab and switches tabs', (t) => {
  let capturedSettings: any;
  let renderer: any;

  act(() => {
    renderer = render(
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
  });

  // Verify initial state
  const categories = capturedSettings.categories;
  t.true(categories.length > 1, 'Should have at least 2 categories to switch');
  const initialCategoryId = categories[0].id;
  const nextCategoryId = categories[1].id;

  t.is(capturedSettings.activeCategoryId, initialCategoryId);
  t.true(capturedSettings.filteredEntries.length > 0);
  t.true(capturedSettings.filteredEntries.every((item: any) => getSettingCategory(item.key).id === initialCategoryId));
  t.is(capturedSettings.selectedIndex, 0);
  t.is(capturedSettings.scrollOffset, 0);

  // Switch category
  act(() => {
    capturedSettings.switchCategory('next');
  });

  t.is(capturedSettings.activeCategoryId, nextCategoryId);
  t.true(capturedSettings.filteredEntries.length > 0);
  t.true(capturedSettings.filteredEntries.every((item: any) => getSettingCategory(item.key).id === nextCategoryId));
  t.is(capturedSettings.selectedIndex, 0);
  t.is(capturedSettings.scrollOffset, 0);

  act(() => {
    renderer.unmount();
  });
});

test('useSettingsCompletion searches all task tabs when query is present', (t) => {
  let capturedSettings: any;
  let renderer: any;

  act(() => {
    renderer = render(
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
  });

  t.is(capturedSettings.activeCategoryId, capturedSettings.categories[0].id);
  t.true(capturedSettings.isSearchingAll);
  t.true(capturedSettings.filteredEntries.some((item: any) => item.key === 'shell.timeout'));

  act(() => {
    renderer.unmount();
  });
});
