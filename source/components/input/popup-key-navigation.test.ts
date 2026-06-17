import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { getPopupNavigationCursor } from './popup-key-navigation.js';

it('left/right move cursor in popup mode when mode has no custom left/right handler', () => {
  expect(
    getPopupNavigationCursor({
      input: '',
      key: { leftArrow: true },
      cursor: 3,
      valueLength: 10,
      hasModeLeftHandler: false,
      hasModeRightHandler: false,
    }),
  ).toBe(2);

  expect(
    getPopupNavigationCursor({
      input: '',
      key: { rightArrow: true },
      cursor: 3,
      valueLength: 10,
      hasModeLeftHandler: false,
      hasModeRightHandler: false,
    }),
  ).toBe(4);
});

it('left/right do not override mode-specific handlers', () => {
  expect(
    getPopupNavigationCursor({
      input: '',
      key: { leftArrow: true },
      cursor: 3,
      valueLength: 10,
      hasModeLeftHandler: true,
      hasModeRightHandler: false,
    }),
  ).toBe(null);

  expect(
    getPopupNavigationCursor({
      input: '',
      key: { rightArrow: true },
      cursor: 3,
      valueLength: 10,
      hasModeLeftHandler: false,
      hasModeRightHandler: true,
    }),
  ).toBe(null);
});

it('home/end keys return null (fall through) in popup mode', () => {
  expect(
    getPopupNavigationCursor({
      input: '',
      key: { home: true },
      cursor: 3,
      valueLength: 10,
      hasModeLeftHandler: false,
      hasModeRightHandler: false,
    }),
  ).toBe(null);

  expect(
    getPopupNavigationCursor({
      input: '',
      key: { end: true },
      cursor: 3,
      valueLength: 10,
      hasModeLeftHandler: false,
      hasModeRightHandler: false,
    }),
  ).toBe(null);
});

it('ctrl+a/ctrl+e move cursor in popup mode', () => {
  expect(
    getPopupNavigationCursor({
      input: 'a',
      key: { ctrl: true },
      cursor: 3,
      valueLength: 10,
      hasModeLeftHandler: false,
      hasModeRightHandler: false,
    }),
  ).toBe(0);

  expect(
    getPopupNavigationCursor({
      input: 'e',
      key: { ctrl: true },
      cursor: 3,
      valueLength: 10,
      hasModeLeftHandler: false,
      hasModeRightHandler: false,
    }),
  ).toBe(10);
});
