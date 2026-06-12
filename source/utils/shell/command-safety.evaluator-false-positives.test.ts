import test from 'ava';
import { classifyCommand, SafetyStatus } from './command-safety/index.js';
import { analyzePathRisk } from './command-safety/path-analysis.js';

// ============================================================================
// Item 1: pure-safe / read-only commands should be GREEN (not "unlisted")
// ============================================================================

test('read-only and output-only commands classify GREEN', (t) => {
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
    t.is(classifyCommand(command), SafetyStatus.GREEN, `"${command}" should be GREEN`);
  }
});

test('compound of newly-allowed safe commands stays GREEN', (t) => {
  t.is(classifyCommand("cd source && printf 'done'"), SafetyStatus.GREEN);
  t.is(classifyCommand('cd source && ls'), SafetyStatus.GREEN);
});

test('dual-use commands are still NOT auto-allowed (remain YELLOW)', (t) => {
  // These genuinely need the evaluator/human and must not be allow-listed.
  for (const command of ['npm test', 'npx tsc', 'node script.js', 'cp a b']) {
    t.is(classifyCommand(command), SafetyStatus.YELLOW, `"${command}" should remain YELLOW`);
  }
});

// ============================================================================
// Item 2: the current directory "." should not be treated as a hidden file
// ============================================================================

test('current-directory path args are GREEN', (t) => {
  t.is(analyzePathRisk('.'), SafetyStatus.GREEN, '"." should be GREEN');
  t.is(analyzePathRisk('./'), SafetyStatus.GREEN, '"./" should be GREEN');
});

test('search tools over the current directory classify GREEN', (t) => {
  t.is(classifyCommand('rg -n "pattern" .'), SafetyStatus.GREEN);
  t.is(classifyCommand('grep -rn "foo" .'), SafetyStatus.GREEN);
});

// ============================================================================
// Item 4: git global options that take a value must not be mistaken for the
//         subcommand (e.g. `git -C <path> status`).
// ============================================================================

test('git global flags before a safe subcommand stay GREEN', (t) => {
  const greenGit = [
    'git -C /some/repo status',
    'git -c user.name=alice log --oneline',
    'git --git-dir=/repo/.git status',
    'git -C source diff',
  ];
  for (const command of greenGit) {
    t.is(classifyCommand(command), SafetyStatus.GREEN, `"${command}" should be GREEN`);
  }
});

test('git global flags before a write subcommand stay YELLOW', (t) => {
  t.is(classifyCommand('git -C /some/repo commit -m wip'), SafetyStatus.YELLOW);
  t.is(classifyCommand('git -C /some/repo reset --hard'), SafetyStatus.YELLOW);
});
