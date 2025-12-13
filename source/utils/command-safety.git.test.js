import test from 'ava';
import {validateCommandSafety} from '../../dist/utils/command-safety/index.js';

// Safe git commands (GREEN - auto-approved)
test('git status is green (safe)', t => {
	t.false(validateCommandSafety('git status'));
});

test('git log is green (safe)', t => {
	t.false(validateCommandSafety('git log --oneline'));
});

test('git diff is green (safe)', t => {
	t.false(validateCommandSafety('git diff HEAD'));
});

test('git show is green (safe)', t => {
	t.false(validateCommandSafety('git show abc123'));
});

test('git blame is green (safe)', t => {
	t.false(validateCommandSafety('git blame file.txt'));
});

test('git reflog is green (safe)', t => {
	t.false(validateCommandSafety('git reflog'));
});

test('git ls-files is green (safe)', t => {
	t.false(validateCommandSafety('git ls-files'));
});

test('git grep is green (safe)', t => {
	t.false(validateCommandSafety('git grep "pattern"'));
});

// Dangerous git commands (YELLOW - requires approval)
test('git push is yellow (write operation)', t => {
	t.true(validateCommandSafety('git push origin main'));
});

test('git commit is yellow (write operation)', t => {
	t.true(validateCommandSafety('git commit -m "message"'));
});

test('git reset is yellow (destructive)', t => {
	t.true(validateCommandSafety('git reset --hard HEAD'));
});

test('git clean is yellow (destructive)', t => {
	t.true(validateCommandSafety('git clean -fd'));
});

test('git rebase is yellow (destructive)', t => {
	t.true(validateCommandSafety('git rebase main'));
});

test('git merge is yellow (write operation)', t => {
	t.true(validateCommandSafety('git merge feature'));
});

test('git add is yellow (write operation)', t => {
	t.true(validateCommandSafety('git add .'));
});

test('git checkout is yellow (branch switching)', t => {
	t.true(validateCommandSafety('git checkout main'));
});

// Safe commands with dangerous flags (YELLOW)
test('git log with force flag is yellow', t => {
	t.true(validateCommandSafety('git log --force'));
});

test('git diff with hard flag is yellow', t => {
	t.true(validateCommandSafety('git diff --hard'));
});

test('git status with delete flag is yellow', t => {
	t.true(validateCommandSafety('git status --delete'));
});

// Unknown subcommands (YELLOW)
test('unknown git subcommand is yellow', t => {
	t.true(validateCommandSafety('git unknowncommand'));
});

// Git without subcommand (YELLOW)
test('git without subcommand is yellow', t => {
	t.true(validateCommandSafety('git'));
});

test('git with only flags is yellow', t => {
	t.true(validateCommandSafety('git --version'));
});
