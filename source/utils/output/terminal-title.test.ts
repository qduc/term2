import { expect, it } from 'vitest';
import {
  buildProjectFolderTitle,
  buildTerminalTitleLabel,
  buildTerminalTitleSequence,
  setTerminalTitle,
} from './terminal-title.js';

it('buildProjectFolderTitle returns the current folder name', () => {
  expect(buildProjectFolderTitle('/home/user/workspace/term2')).toBe('term2');
});

it('buildProjectFolderTitle falls back when the folder name is empty', () => {
  expect(buildProjectFolderTitle('/')).toBe('term2');
});

it('buildProjectFolderTitle falls back for a relative dot path', () => {
  expect(buildProjectFolderTitle('.')).toBe('term2');
});

it('buildTerminalTitleLabel prepends running indicator when processing', () => {
  expect(buildTerminalTitleLabel('term2', true)).toBe('[...] term2');
});

it('buildTerminalTitleLabel returns the base title when idle', () => {
  expect(buildTerminalTitleLabel('term2', false)).toBe('term2');
});

it('buildTerminalTitleSequence emits an OSC 0 title update', () => {
  expect(buildTerminalTitleSequence('term2')).toBe('\x1b]0;term2\x07');
});

it('setTerminalTitle writes the OSC title sequence through the TTY writer', () => {
  let written = '';

  setTerminalTitle('term2', {
    env: {},
    getTtyWriter: () => (data) => {
      written = data;
    },
  });

  expect(written).toBe('\x1b]0;term2\x07');
});
