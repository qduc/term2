import test from 'ava';
import { getPopupNavigationCursor } from './popup-key-navigation.js';

test('left/right move cursor in popup mode when mode has no custom left/right handler', (t) => {
  t.is(
    getPopupNavigationCursor({
      input: '',
      key: { leftArrow: true },
      cursor: 3,
      valueLength: 10,
      hasModeLeftHandler: false,
      hasModeRightHandler: false,
    }),
    2,
  );

  t.is(
    getPopupNavigationCursor({
      input: '',
      key: { rightArrow: true },
      cursor: 3,
      valueLength: 10,
      hasModeLeftHandler: false,
      hasModeRightHandler: false,
    }),
    4,
  );
});

test('left/right do not override mode-specific handlers', (t) => {
  t.is(
    getPopupNavigationCursor({
      input: '',
      key: { leftArrow: true },
      cursor: 3,
      valueLength: 10,
      hasModeLeftHandler: true,
      hasModeRightHandler: false,
    }),
    null,
  );

  t.is(
    getPopupNavigationCursor({
      input: '',
      key: { rightArrow: true },
      cursor: 3,
      valueLength: 10,
      hasModeLeftHandler: false,
      hasModeRightHandler: true,
    }),
    null,
  );
});

test('home/end and ctrl+a/ctrl+e move cursor in popup mode', (t) => {
  t.is(
    getPopupNavigationCursor({
      input: '',
      key: { home: true },
      cursor: 3,
      valueLength: 10,
      hasModeLeftHandler: false,
      hasModeRightHandler: false,
    }),
    0,
  );

  t.is(
    getPopupNavigationCursor({
      input: '',
      key: { end: true },
      cursor: 3,
      valueLength: 10,
      hasModeLeftHandler: false,
      hasModeRightHandler: false,
    }),
    10,
  );

  t.is(
    getPopupNavigationCursor({
      input: 'a',
      key: { ctrl: true },
      cursor: 3,
      valueLength: 10,
      hasModeLeftHandler: false,
      hasModeRightHandler: false,
    }),
    0,
  );

  t.is(
    getPopupNavigationCursor({
      input: 'e',
      key: { ctrl: true },
      cursor: 3,
      valueLength: 10,
      hasModeLeftHandler: false,
      hasModeRightHandler: false,
    }),
    10,
  );
});
