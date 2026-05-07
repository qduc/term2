import test from 'ava';
import { calculateViewportStart } from './viewport.js';

test('calculateViewportStart - returns 0 for items within visible count', (t) => {
  t.is(calculateViewportStart(10, 0, 15), 0);
  t.is(calculateViewportStart(10, 5, 15), 0);
  t.is(calculateViewportStart(10, 9, 15), 0);
  t.is(calculateViewportStart(5, 4, 10), 0);
});

test('calculateViewportStart - returns 0 when selected is near the top', (t) => {
  const visibleCount = 15;
  t.is(calculateViewportStart(30, 0, visibleCount), 0);
  t.is(calculateViewportStart(30, 7, visibleCount), 0);
  t.is(calculateViewportStart(30, 7, 15), 0);
});

test('calculateViewportStart - centers on selected item in the middle range', (t) => {
  const visibleCount = 15;
  // selectedIndex = 10, half = 7 → viewportStart = 3
  t.is(calculateViewportStart(50, 10, visibleCount), 3);
  // selectedIndex = 20, half = 7 → viewportStart = 13
  t.is(calculateViewportStart(50, 20, visibleCount), 13);
});

test('calculateViewportStart - snaps to end when selected is near the bottom', (t) => {
  const visibleCount = 15;
  // Items = 20, selected = 19, half = 7
  // selectedItem >= items.length - half → 19 >= 20 - 7 = 13 → true
  // viewportStart = 20 - 15 = 5
  t.is(calculateViewportStart(20, 19, visibleCount), 5);
  // Items = 30, selected = 25, half = 7
  // 25 >= 30 - 7 = 23 → true
  // viewportStart = 30 - 15 = 15
  t.is(calculateViewportStart(30, 25, visibleCount), 15);
});

test('calculateViewportStart - handles edge case: items count equals visible count', (t) => {
  t.is(calculateViewportStart(10, 0, 10), 0);
  t.is(calculateViewportStart(10, 9, 10), 0);
});

test('calculateViewportStart - handles edge case: single item', (t) => {
  t.is(calculateViewportStart(1, 0, 15), 0);
});

test('calculateViewportStart - handles edge case: empty items', (t) => {
  t.is(calculateViewportStart(0, 0, 15), 0);
});
