import { it, expect } from 'vitest';
import { validateCommandSafety } from './command-safety/index.js';

// Safe git commands (GREEN - auto-approved)
it('git status is green (safe)', () => {
  expect(validateCommandSafety('git status')).toBe(false);
});

it('git log is green (safe)', () => {
  expect(validateCommandSafety('git log --oneline')).toBe(false);
});

it('git diff is green (safe)', () => {
  expect(validateCommandSafety('git diff HEAD')).toBe(false);
});

it('git show is green (safe)', () => {
  expect(validateCommandSafety('git show abc123')).toBe(false);
});

it('git blame is green (safe)', () => {
  expect(validateCommandSafety('git blame file.txt')).toBe(false);
});

it('git reflog is green (safe)', () => {
  expect(validateCommandSafety('git reflog')).toBe(false);
});

it('git ls-files is green (safe)', () => {
  expect(validateCommandSafety('git ls-files')).toBe(false);
});

it('git grep is green (safe)', () => {
  expect(validateCommandSafety('git grep "pattern"')).toBe(false);
});

// Dangerous git commands (YELLOW - requires approval)
it('git push is yellow (write operation)', () => {
  expect(validateCommandSafety('git push origin main')).toBe(true);
});

it('git commit is yellow (write operation)', () => {
  expect(validateCommandSafety('git commit -m "message"')).toBe(true);
});

it('git reset is yellow (destructive)', () => {
  expect(validateCommandSafety('git reset --hard HEAD')).toBe(true);
});

it('git clean is yellow (destructive)', () => {
  expect(validateCommandSafety('git clean -fd')).toBe(true);
});

it('git rebase is yellow (destructive)', () => {
  expect(validateCommandSafety('git rebase main')).toBe(true);
});

it('git merge is yellow (write operation)', () => {
  expect(validateCommandSafety('git merge feature')).toBe(true);
});

it('git add is yellow (write operation)', () => {
  expect(validateCommandSafety('git add .')).toBe(true);
});

it('git checkout is yellow (branch switching)', () => {
  expect(validateCommandSafety('git checkout main')).toBe(true);
});

// Safe commands with dangerous flags (YELLOW)
it('git log with force flag is yellow', () => {
  expect(validateCommandSafety('git log --force')).toBe(true);
});

it('git diff with hard flag is yellow', () => {
  expect(validateCommandSafety('git diff --hard')).toBe(true);
});

it('git status with delete flag is yellow', () => {
  expect(validateCommandSafety('git status --delete')).toBe(true);
});

// Unknown subcommands (YELLOW)
it('unknown git subcommand is yellow', () => {
  expect(validateCommandSafety('git unknowncommand')).toBe(true);
});

// Git without subcommand (YELLOW)
it('git without subcommand is yellow', () => {
  expect(validateCommandSafety('git')).toBe(true);
});

it('git with only flags is yellow', () => {
  expect(validateCommandSafety('git --version')).toBe(true);
});
