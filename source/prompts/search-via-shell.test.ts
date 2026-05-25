import test from 'ava';
import { getSearchViaShellAddendum } from './search-via-shell.js';

function includesWord(text: string, word: string): boolean {
  return new RegExp(`\\b${word}\\b`, 'i').test(text);
}

test('getSearchViaShellAddendum recommends rg and fd when both available', (t) => {
  const result = getSearchViaShellAddendum({
    checkBinary: () => true,
  });

  t.true(includesWord(result, 'rg'));
  t.true(includesWord(result, 'fd'));
  t.false(includesWord(result, 'grep'));
  t.false(includesWord(result, 'find'));
  t.true(result.toLowerCase().includes('hygiene'));
});

test('getSearchViaShellAddendum falls back to grep when rg is missing', (t) => {
  const result = getSearchViaShellAddendum({
    checkBinary: (cmd) => cmd === 'fd',
  });

  t.false(includesWord(result, 'rg'));
  t.true(includesWord(result, 'grep'));
  t.true(includesWord(result, 'fd'));
  t.false(includesWord(result, 'find'));
});

test('getSearchViaShellAddendum falls back to find when fd is missing', (t) => {
  const result = getSearchViaShellAddendum({
    checkBinary: (cmd) => cmd === 'rg',
  });

  t.true(includesWord(result, 'rg'));
  t.false(includesWord(result, 'fd'));
  t.true(includesWord(result, 'find'));
});

test('getSearchViaShellAddendum falls back to grep and find when both missing', (t) => {
  const result = getSearchViaShellAddendum({
    checkBinary: () => false,
  });

  t.false(includesWord(result, 'rg'));
  t.true(includesWord(result, 'grep'));
  t.false(includesWord(result, 'fd'));
  t.true(includesWord(result, 'find'));
  t.true(result.toLowerCase().includes('hygiene'));
});
