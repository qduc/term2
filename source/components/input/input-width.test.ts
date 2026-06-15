import test from 'ava';
import { calculateInputWidth } from './input-width.js';

test('calculateInputWidth uses default prompt width for normal mode', (t) => {
  t.is(calculateInputWidth({ terminalColumns: 80, waitingForRejectionReason: false, isShellMode: false }), 74);
});

test('calculateInputWidth uses default prompt width for shell mode', (t) => {
  t.is(calculateInputWidth({ terminalColumns: 80, waitingForRejectionReason: false, isShellMode: true }), 74);
});

test('calculateInputWidth uses rejection prompt width for rejection mode', (t) => {
  t.is(calculateInputWidth({ terminalColumns: 80, waitingForRejectionReason: true, isShellMode: false }), 71);
});

test('calculateInputWidth handles custom promptLabel', (t) => {
  t.is(
    calculateInputWidth({
      terminalColumns: 80,
      waitingForRejectionReason: false,
      isShellMode: false,
      promptLabel: 'Enter Provider Name: ',
    }),
    80 - 4 - 'Enter Provider Name: '.length,
  );
});

test('calculateInputWidth returns 0 when terminalColumns is undefined', (t) => {
  t.is(calculateInputWidth({ waitingForRejectionReason: false, isShellMode: false }), 0);
});
