import test from 'ava';
import { getSearchViaShellAddendum } from './search-via-shell.js';

test('getSearchViaShellAddendum includes rg and fd when both available', (t) => {
  const result = getSearchViaShellAddendum({
    checkBinary: () => true,
  });

  t.true(result.includes('use `rg` (ripgrep)'));
  t.true(result.includes('use `fd`'));
  t.false(result.includes('use `grep`'));
  t.false(result.includes('use `find`'));
  t.true(result.includes('General shell hygiene'));
});

test('getSearchViaShellAddendum falls back to grep when rg is missing', (t) => {
  const result = getSearchViaShellAddendum({
    checkBinary: (cmd) => cmd === 'fd',
  });

  t.false(result.includes('use `rg` (ripgrep)'));
  t.true(result.includes('use `grep`'));
  t.true(result.includes('use `fd`'));
  t.false(result.includes('use `find`'));
});

test('getSearchViaShellAddendum falls back to find when fd is missing', (t) => {
  const result = getSearchViaShellAddendum({
    checkBinary: (cmd) => cmd === 'rg',
  });

  t.true(result.includes('use `rg` (ripgrep)'));
  t.false(result.includes('use `fd`'));
  t.true(result.includes('use `find`'));
});

test('getSearchViaShellAddendum falls back to grep and find when both missing', (t) => {
  const result = getSearchViaShellAddendum({
    checkBinary: () => false,
  });

  t.false(result.includes('use `rg` (ripgrep)'));
  t.true(result.includes('use `grep`'));
  t.false(result.includes('use `fd`'));
  t.true(result.includes('use `find`'));
  t.true(result.includes('General shell hygiene'));
});
