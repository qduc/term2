import { it, expect } from 'vitest';
import { toPopupProps } from './popup-props.js';

it('toPopupProps forwards path completion state', () => {
  const props = toPopupProps({
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
    rewind: {
      isOpen: false,
      items: [],
      selectedIndex: 0,
      scrollOffset: 0,
      disposition: 'edit',
    } as any,
    skills: {
      isOpen: false,
      skills: [],
      selectedIndex: 0,
      scrollOffset: 0,
      query: '',
    } as any,
  });

  expect(props.path.scrollOffset).toBe(0);
});
