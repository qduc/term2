export type { RewindItem } from './menu-types.js';

export const REWIND_MENU_VISIBLE_ITEMS = 5;

export function getRewindScrollOffset(itemsLength: number, selectedIndex: number, scrollOffset: number): number {
  if (itemsLength <= REWIND_MENU_VISIBLE_ITEMS) return 0;
  if (selectedIndex < scrollOffset) return selectedIndex;
  if (selectedIndex >= scrollOffset + REWIND_MENU_VISIBLE_ITEMS) {
    return selectedIndex - REWIND_MENU_VISIBLE_ITEMS + 1;
  }
  return scrollOffset;
}
