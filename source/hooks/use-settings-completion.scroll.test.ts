// @ts-ignore
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import React, { useEffect, act } from 'react';
import { render } from 'ink-testing-library';
import { InputProvider, useInputContext } from '../context/InputContext.js';
import { SETTINGS_TRIGGER } from '../components/input/triggers.js';
import { useSettingsCompletion, getSettingCategory } from './use-settings-completion.js';
import { createMockSettingsService } from '../services/settings/settings-service.mock.js';
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

it('useSettingsCompletion filters settings by active task tab and switches tabs', () => {
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
  expect(categories.length > 1).toBe(true);
  const initialCategoryId = categories[0].id;
  const nextCategoryId = categories[1].id;

  expect(capturedSettings.activeCategoryId).toBe(initialCategoryId);
  expect(capturedSettings.filteredEntries.length > 0).toBe(true);
  expect(
    capturedSettings.filteredEntries.every((item: any) => getSettingCategory(item.key).id === initialCategoryId),
  ).toBe(true);
  expect(capturedSettings.selectedIndex).toBe(0);
  expect(capturedSettings.scrollOffset).toBe(0);

  // Switch category
  act(() => {
    capturedSettings.switchCategory('next');
  });

  expect(capturedSettings.activeCategoryId).toBe(nextCategoryId);
  expect(capturedSettings.filteredEntries.length > 0).toBe(true);
  expect(
    capturedSettings.filteredEntries.every((item: any) => getSettingCategory(item.key).id === nextCategoryId),
  ).toBe(true);
  expect(capturedSettings.selectedIndex).toBe(0);
  expect(capturedSettings.scrollOffset).toBe(0);

  act(() => {
    renderer.unmount();
  });
});

it('useSettingsCompletion searches all task tabs when query is present', () => {
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

  expect(capturedSettings.activeCategoryId).toBe(capturedSettings.categories[0].id);
  expect(capturedSettings.isSearchingAll).toBe(true);
  expect(capturedSettings.filteredEntries.some((item: any) => item.key === 'shell.timeout')).toBe(true);

  act(() => {
    renderer.unmount();
  });
});
