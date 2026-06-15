import test from 'ava';
import { computeVisibleTabs } from './compute-visible-tabs.js';

// Helpers
const tab = (id: string, labelLen: number) => ({ id, width: labelLen });
const tabList = (specs: [string, number][]) => specs.map(([id, w]) => tab(id, w));
const width = (item: { width: number }) => item.width;

test('returns empty result for empty items', (t) => {
  const result = computeVisibleTabs([], 'a', 80, width);
  t.is(result.visibleItems.length, 0);
  t.is(result.startIndex, 0);
  t.is(result.endIndex, -1);
  t.false(result.hasLeftScroll);
  t.false(result.hasRightScroll);
});

test('shows all items when they fit', (t) => {
  const items = tabList([
    ['a', 5],
    ['b', 5],
    ['c', 5],
  ]);
  // 3 items × ~8 chars each (width + separator) ≈ 24 chars, well under 80
  const result = computeVisibleTabs(items, 'b', 80, width);
  t.deepEqual(result.visibleItems, items);
  t.false(result.hasLeftScroll);
  t.false(result.hasRightScroll);
  t.is(result.startIndex, 0);
  t.is(result.endIndex, 2);
});

test('centers on active item when not all fit', (t) => {
  // 10 items × 10 width each ≈ 10+3 = 13 chars per tab after first
  // First tab: width + 4 = 14 chars
  // With 60 chars available, can fit roughly 4-5 items
  const items = tabList([
    ['a', 10],
    ['b', 10],
    ['c', 10],
    ['d', 10],
    ['e', 10],
    ['f', 10],
    ['g', 10],
    ['h', 10],
    ['i', 10],
    ['j', 10],
  ]);
  const result = computeVisibleTabs(items, 'd', 60, width);
  // Active item 'd' (index 3) should be included
  t.true(result.visibleItems.some((item) => item.id === 'd'));
  t.true(result.hasLeftScroll);
  t.true(result.hasRightScroll);
});

test('defaults to first item when activeItemId is not found', (t) => {
  const items = tabList([
    ['a', 5],
    ['b', 5],
  ]);
  const result = computeVisibleTabs(items, 'z', 80, width);
  t.is(result.startIndex, 0);
  t.is(result.visibleItems[0]!.id, 'a');
});

test('sets hasLeftScroll when tabs before the visible window exist', (t) => {
  const items = tabList([
    ['a', 20],
    ['b', 20],
    ['c', 20],
    ['d', 20],
    ['e', 20],
  ]);
  // Available width 50: active item 'd' (width 20) + 4 = 24. Can maybe fit one more (20+3=23 > 50-24=26)
  // Actually let's check: start=d(3), try right=e(4): 24+23=47<=50 → yes. Try left=c(2): 47+23=70>50 → no
  // So visible = [d, e] with hasLeftScroll=true
  const result = computeVisibleTabs(items, 'd', 50, width);
  t.true(result.hasLeftScroll);
  t.not(result.startIndex, 0);
});

test('sets hasRightScroll when tabs after the visible window exist', (t) => {
  const items = tabList([
    ['a', 20],
    ['b', 20],
    ['c', 20],
    ['d', 20],
    ['e', 20],
  ]);
  // Available width 50: active item 'b' (width 20) + 4 = 24. Try right 'c': 24+23=47<=50 → yes. Try left 'a': 47+23=70>50 → no.
  // Visible = [b, c], hasRightScroll = true
  const result = computeVisibleTabs(items, 'b', 50, width);
  t.true(result.hasRightScroll);
});

test('does not set scroll indicators when all items are visible', (t) => {
  const items = tabList([
    ['a', 5],
    ['b', 5],
  ]);
  const result = computeVisibleTabs(items, 'a', 80, width);
  t.false(result.hasLeftScroll);
  t.false(result.hasRightScroll);
});
