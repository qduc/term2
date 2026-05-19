import test from 'ava';
import { getSearchViaShellAddendum } from './search-via-shell.js';

test('getSearchViaShellAddendum includes rg and fd when both available', (t) => {
  const result = getSearchViaShellAddendum({
    checkBinary: () => true,
  });

  t.true(result.includes('`rg`'));
  t.true(result.includes('`fd`'));
  t.false(result.includes('`grep`'));
  t.false(result.includes('`find`'));
  t.true(result.toLowerCase().includes('hygiene'));
});

test('getSearchViaShellAddendum falls back to grep when rg is missing', (t) => {
  const result = getSearchViaShellAddendum({
    checkBinary: (cmd) => cmd === 'fd',
  });

  t.false(result.includes('`rg`'));
  t.true(result.includes('`grep`'));
  t.true(result.includes('`fd`'));
  t.false(result.includes('`find`'));
});

test('getSearchViaShellAddendum falls back to find when fd is missing', (t) => {
  const result = getSearchViaShellAddendum({
    checkBinary: (cmd) => cmd === 'rg',
  });

  t.true(result.includes('`rg`'));
  t.false(result.includes('`fd`'));
  t.true(result.includes('`find`'));
});

test('getSearchViaShellAddendum falls back to grep and find when both missing', (t) => {
  const result = getSearchViaShellAddendum({
    checkBinary: () => false,
  });

  t.false(result.includes('`rg`'));
  t.true(result.includes('`grep`'));
  t.false(result.includes('`fd`'));
  t.true(result.includes('`find`'));
  t.true(result.toLowerCase().includes('hygiene'));
});
