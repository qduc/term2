import { it, expect } from 'vitest';
import { classifyCommand, SafetyStatus } from './command-safety/index.js';
import { analyzePathRisk } from './command-safety/path-analysis.js';

// ============================================================================
// Item 1: pure-safe / read-only commands should be GREEN (not "unlisted")
// ============================================================================

it('read-only and output-only commands classify GREEN', () => {
  const greenCommands = [
    'cd source',
    "printf 'hello world'",
    'true',
    'false',
    'which node',
    'type ls',
    'basename src/foo.ts',
    'dirname src/foo.ts',
    'realpath src/foo.ts',
    'seq 1 10',
    'comm a.txt b.txt',
    'column -t data.txt',
    'diff a.txt b.txt',
    'xxd dist/bundle.bin',
    'od -c file.bin',
    'hexdump -C file.bin',
    'du -sh node_modules',
    'df -h',
  ];

  for (const command of greenCommands) {
    expect(classifyCommand(command), `"${command}" should be GREEN`).toBe(SafetyStatus.GREEN);
  }
});

it('compound of newly-allowed safe commands stays GREEN', () => {
  expect(classifyCommand("cd source && printf 'done'")).toBe(SafetyStatus.GREEN);
  expect(classifyCommand('cd source && ls')).toBe(SafetyStatus.GREEN);
});

it('dual-use commands are still NOT auto-allowed (remain YELLOW)', () => {
  // These genuinely need the evaluator/human and must not be allow-listed.
  for (const command of ['npm test', 'npx tsc', 'node script.js', 'cp a b']) {
    expect(classifyCommand(command), `"${command}" should remain YELLOW`).toBe(SafetyStatus.YELLOW);
  }
});

// ============================================================================
// Item 2: the current directory "." should not be treated as a hidden file
// ============================================================================

it('current-directory path args are GREEN', () => {
  expect(analyzePathRisk('.'), '"." should be GREEN').toBe(SafetyStatus.GREEN);
  expect(analyzePathRisk('./'), '"./" should be GREEN').toBe(SafetyStatus.GREEN);
});

it('search tools over the current directory classify GREEN', () => {
  expect(classifyCommand('rg -n "pattern" .')).toBe(SafetyStatus.GREEN);
  expect(classifyCommand('grep -rn "foo" .')).toBe(SafetyStatus.GREEN);
});

// ============================================================================
// Item 4: git global options that take a value must not be mistaken for the
//         subcommand (e.g. `git -C <path> status`).
// ============================================================================

it('git global flags before a safe subcommand stay GREEN', () => {
  const greenGit = [
    'git -C /some/repo status',
    'git -c user.name=alice log --oneline',
    'git --git-dir=/repo/.git status',
    'git -C source diff',
  ];
  for (const command of greenGit) {
    expect(classifyCommand(command), `"${command}" should be GREEN`).toBe(SafetyStatus.GREEN);
  }
});

it('git global flags before a write subcommand stay YELLOW', () => {
  expect(classifyCommand('git -C /some/repo commit -m wip')).toBe(SafetyStatus.YELLOW);
  expect(classifyCommand('git -C /some/repo reset --hard')).toBe(SafetyStatus.YELLOW);
});
