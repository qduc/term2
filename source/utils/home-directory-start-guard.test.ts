import test from 'ava';
import {
  confirmHomeDirectoryStart,
  isAffirmativeAnswer,
  isExactDirectory,
  shouldWarnOnHomeDirectoryStart,
} from './home-directory-start-guard.js';

test('isExactDirectory only matches the exact path', (t) => {
  t.true(isExactDirectory('/home/user', '/home/user'));
  t.false(isExactDirectory('/home/user/project', '/home/user'));
  t.false(isExactDirectory('/home/other', '/home/user'));
});

test('shouldWarnOnHomeDirectoryStart only warns at the exact home directory or root directory', (t) => {
  t.true(
    shouldWarnOnHomeDirectoryStart({
      cwd: '/home/user',
      homeDir: '/home/user',
      isNonLiteStart: true,
    }),
  );
  t.false(
    shouldWarnOnHomeDirectoryStart({
      cwd: '/home/user/project',
      homeDir: '/home/user',
      isNonLiteStart: false,
    }),
  );
  t.false(
    shouldWarnOnHomeDirectoryStart({
      cwd: '/home/user/project',
      homeDir: '/home/user',
      isNonLiteStart: true,
    }),
  );
  t.true(
    shouldWarnOnHomeDirectoryStart({
      cwd: '/',
      homeDir: '/home/user',
      isNonLiteStart: true,
    }),
  );
});

test('isAffirmativeAnswer accepts yes and y responses only', (t) => {
  t.true(isAffirmativeAnswer('y'));
  t.true(isAffirmativeAnswer(' yes '));
  t.false(isAffirmativeAnswer('n'));
  t.false(isAffirmativeAnswer(''));
});

test('confirmHomeDirectoryStart resolves affirmative answers', async (t) => {
  t.true(await confirmHomeDirectoryStart(async () => 'yes'));
  t.false(await confirmHomeDirectoryStart(async () => 'no'));
});
