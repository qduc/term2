import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { getSearchViaShellAddendum } from './search-via-shell.js';

function includesWord(text: string, word: string): boolean {
  return new RegExp(`\\b${word}\\b`, 'i').test(text);
}

it('getSearchViaShellAddendum recommends rg and fd when both available', () => {
  const result = getSearchViaShellAddendum({
    checkBinary: () => true,
  });

  expect(includesWord(result, 'rg')).toBe(true);
  expect(includesWord(result, 'fd')).toBe(true);
  expect(includesWord(result, 'grep')).toBe(false);
  expect(includesWord(result, 'find')).toBe(false);
  expect(result.toLowerCase().includes('hygiene')).toBe(true);
});

it('getSearchViaShellAddendum falls back to grep when rg is missing', () => {
  const result = getSearchViaShellAddendum({
    checkBinary: (cmd) => cmd === 'fd',
  });

  expect(includesWord(result, 'rg')).toBe(false);
  expect(includesWord(result, 'grep')).toBe(true);
  expect(includesWord(result, 'fd')).toBe(true);
  expect(includesWord(result, 'find')).toBe(false);
});

it('getSearchViaShellAddendum falls back to find when fd is missing', () => {
  const result = getSearchViaShellAddendum({
    checkBinary: (cmd) => cmd === 'rg',
  });

  expect(includesWord(result, 'rg')).toBe(true);
  expect(includesWord(result, 'fd')).toBe(false);
  expect(includesWord(result, 'find')).toBe(true);
});

it('getSearchViaShellAddendum falls back to grep and find when both missing', () => {
  const result = getSearchViaShellAddendum({
    checkBinary: () => false,
  });

  expect(includesWord(result, 'rg')).toBe(false);
  expect(includesWord(result, 'grep')).toBe(true);
  expect(includesWord(result, 'fd')).toBe(false);
  expect(includesWord(result, 'find')).toBe(true);
  expect(result.toLowerCase().includes('hygiene')).toBe(true);
});
