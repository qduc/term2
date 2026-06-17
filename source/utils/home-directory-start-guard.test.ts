import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import {
  confirmHomeDirectoryStart,
  isAffirmativeAnswer,
  isExactDirectory,
  shouldWarnOnHomeDirectoryStart,
} from './home-directory-start-guard.js';

it('isExactDirectory only matches the exact path', () => {
  expect(isExactDirectory('/home/user', '/home/user')).toBe(true);
  expect(isExactDirectory('/home/user/project', '/home/user')).toBe(false);
  expect(isExactDirectory('/home/other', '/home/user')).toBe(false);
});

it('shouldWarnOnHomeDirectoryStart only warns at the exact home directory or root directory', () => {
  expect(
    shouldWarnOnHomeDirectoryStart({
      cwd: '/home/user',
      homeDir: '/home/user',
      isNonLiteStart: true,
    }),
  ).toBe(true);
  expect(
    shouldWarnOnHomeDirectoryStart({
      cwd: '/home/user/project',
      homeDir: '/home/user',
      isNonLiteStart: false,
    }),
  ).toBe(false);
  expect(
    shouldWarnOnHomeDirectoryStart({
      cwd: '/home/user/project',
      homeDir: '/home/user',
      isNonLiteStart: true,
    }),
  ).toBe(false);
  expect(
    shouldWarnOnHomeDirectoryStart({
      cwd: '/',
      homeDir: '/home/user',
      isNonLiteStart: true,
    }),
  ).toBe(true);
});

it('isAffirmativeAnswer accepts yes and y responses only', () => {
  expect(isAffirmativeAnswer('y')).toBe(true);
  expect(isAffirmativeAnswer(' yes ')).toBe(true);
  expect(isAffirmativeAnswer('n')).toBe(false);
  expect(isAffirmativeAnswer('')).toBe(false);
});

it('confirmHomeDirectoryStart resolves affirmative answers', async () => {
  expect(await confirmHomeDirectoryStart(async () => 'yes')).toBe(true);
  expect(await confirmHomeDirectoryStart(async () => 'no')).toBe(false);
});
