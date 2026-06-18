import { it, expect } from 'vitest';
import { toPopupProps } from './popup-props.js';

it('toPopupProps forwards slash scrollOffset', () => {
  const props = toPopupProps({
    slash: {
      isOpen: true,
      filteredCommands: [],
      selectedIndex: 0,
      scrollOffset: 3,
      filter: 'mod',
      open: () => {},
      close: () => {},
      moveUp: () => {},
      moveDown: () => {},
      moveHome: () => {},
      moveEnd: () => {},
      pageUp: () => {},
      pageDown: () => {},
      getSelectedItem: () => undefined,
      executeSelected: () => {},
      completeSelected: () => {},
    } as any,
    path: {
      isOpen: false,
      filteredEntries: [],
      selectedIndex: 0,
      scrollOffset: 0,
      query: '',
      loading: false,
      error: null,
    } as any,
    settings: {
      isOpen: false,
      filteredEntries: [],
      selectedIndex: 0,
      scrollOffset: 0,
      query: '',
      isSearchingAll: false,
      activeCategoryId: '',
      categories: [],
    } as any,
    settingsValue: {
      isOpen: false,
      settingKey: null,
      filteredEntries: [],
      selectedIndex: 0,
      query: '',
      isNumericSettings: false,
    } as any,
    models: {
      isOpen: false,
      filteredModels: [],
      selectedIndex: 0,
      query: '',
      loading: false,
      error: null,
      provider: null,
      scrollOffset: 0,
      canSwitchProvider: false,
    } as any,
    undo: {
      isOpen: false,
      items: [],
      selectedIndex: 0,
      scrollOffset: 0,
    } as any,
    providers: {
      isOpen: false,
      phase: 'list',
      selectedIndex: 0,
      getActiveItems: () => [],
      errorMessage: null,
      selectedProvider: null,
      draft: null,
    } as any,
    skills: {
      isOpen: false,
      skills: [],
      selectedIndex: 0,
      scrollOffset: 0,
      query: '',
    } as any,
  });

  expect(props.slash.scrollOffset).toBe(3);
});
