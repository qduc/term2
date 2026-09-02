import { it, expect } from 'vitest';
import { validateCommandSafety } from './command-safety/index.js';

// validateCommandSafety returns true when the command requires approval.
// One table over (command, requiresApproval) pairs keeps the whole git
// subcommand matrix visible without 22 singleton cases.
it.each<[string, boolean]>([
  // Read-only git commands (GREEN - auto-approved)
  ['git status', false],
  ['git log --oneline', false],
  ['git diff HEAD', false],
  ['git show abc123', false],
  ['git blame file.txt', false],
  ['git reflog', false],
  ['git ls-files', false],
  ['git grep "pattern"', false],
  // Mutating git commands (YELLOW - requires approval)
  ['git push origin main', true],
  ['git commit -m "message"', true],
  ['git reset --hard HEAD', true],
  ['git clean -fd', true],
  ['git rebase main', true],
  ['git merge feature', true],
  ['git add .', true],
  ['git checkout main', true],
  // An unrecognized flag on an otherwise-safe command hits the generic
  // unknown-flag rule and requires approval (not a git-specific policy).
  ['git log --force', true],
  ['git diff --hard', true],
  ['git status --delete', true],
  // Unknown subcommand and no-subcommand forms require approval.
  ['git unknowncommand', true],
  ['git', true],
  ['git --version', true],
])('git command "%s" requires approval: %s', (command, requiresApproval) => {
  expect(validateCommandSafety(command)).toBe(requiresApproval);
});
