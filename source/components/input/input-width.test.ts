import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { calculateInputWidth } from './input-width.js';

it('calculateInputWidth uses default prompt width for normal mode', () => {
  expect(calculateInputWidth({ terminalColumns: 80, waitingForRejectionReason: false, isShellMode: false })).toBe(74);
});

it('calculateInputWidth uses default prompt width for shell mode', () => {
  expect(calculateInputWidth({ terminalColumns: 80, waitingForRejectionReason: false, isShellMode: true })).toBe(74);
});

it('calculateInputWidth uses rejection prompt width for rejection mode', () => {
  expect(calculateInputWidth({ terminalColumns: 80, waitingForRejectionReason: true, isShellMode: false })).toBe(71);
});

it('calculateInputWidth handles custom promptLabel', () => {
  expect(
    calculateInputWidth({
      terminalColumns: 80,
      waitingForRejectionReason: false,
      isShellMode: false,
      promptLabel: 'Enter Provider Name: ',
    }),
  ).toBe(80 - 4 - 'Enter Provider Name: '.length);
});

it('calculateInputWidth returns 0 when terminalColumns is undefined', () => {
  expect(calculateInputWidth({ waitingForRejectionReason: false, isShellMode: false })).toBe(0);
});
