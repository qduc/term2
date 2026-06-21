import { it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getProjectTreeForPrompt } from './project-tree.js';

type TreeSpec = Record<string, 'dir' | 'file'>;

const tmpDirs: string[] = [];

function buildTree(spec: TreeSpec): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-project-tree-'));
  tmpDirs.push(root);
  for (const [rel, type] of Object.entries(spec)) {
    const abs = path.join(root, rel);
    if (type === 'dir') {
      fs.mkdirSync(abs, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, '');
    }
  }
  return root;
}

afterEach(() => {
  while (tmpDirs.length) {
    fs.rmSync(tmpDirs.pop() as string, { recursive: true, force: true });
  }
});

it('getProjectTreeForPrompt nests directory children under the correct parent (not a later sibling file)', () => {
  const root = buildTree({
    'a/inner/file-under-inner.txt': 'file',
    'a/file-under-a.txt': 'file',
  });

  const out = getProjectTreeForPrompt(root, {
    maxDepth: 5,
    maxEntriesPerDir: 100,
    maxTotalEntries: 1000,
  });

  expect(out).toBe(
    ['Project structure:', '.', '  a/', '    inner/', '      file-under-inner.txt', '    file-under-a.txt', ''].join(
      '\n',
    ),
  );
});

it('getProjectTreeForPrompt renders space indent without box-drawing characters', () => {
  const root = buildTree({
    'src/index.ts': 'file',
    'src/lib/util.ts': 'file',
    'README.md': 'file',
  });

  const out = getProjectTreeForPrompt(root, {
    maxDepth: 5,
    maxEntriesPerDir: 100,
    maxTotalEntries: 1000,
  });

  expect(out.includes('└')).toBe(false);
  expect(out.includes('├')).toBe(false);
  expect(out.includes('│')).toBe(false);
  expect(out.includes('└─')).toBe(false);
  expect(out.includes('    index.ts')).toBe(true);
  expect(out.includes('    lib/')).toBe(true);
});

it('getProjectTreeForPrompt marks directories beyond maxDepth with an ellipsis and does not recurse', () => {
  const root = buildTree({
    'a/b/c/secret.txt': 'file',
    'a/top.txt': 'file',
  });

  const out = getProjectTreeForPrompt(root, { maxDepth: 2, maxEntriesPerDir: 100, maxTotalEntries: 1000 });

  expect(out).toBe(['Project structure:', '.', '  a/', '    b/', '      …', '    top.txt', ''].join('\n'));
});

it('getProjectTreeForPrompt reports per-directory truncation inline and omits the footer for it', () => {
  const root = buildTree({
    'a.txt': 'file',
    'b.txt': 'file',
    'c.txt': 'file',
  });

  const out = getProjectTreeForPrompt(root, {
    maxDepth: 5,
    maxEntriesPerDir: 2,
    maxTotalEntries: 1000,
  });

  expect(out).toBe(['Project structure:', '.', '  a.txt', '  b.txt', '  ... (1 more)', ''].join('\n'));
  expect(out.includes('Omitted')).toBe(false);
});

it('getProjectTreeForPrompt reports total-budget cuts in a footer separate from per-directory truncation', () => {
  const root = buildTree({
    'a.txt': 'file',
    'b.txt': 'file',
    'c.txt': 'file',
    'd.txt': 'file',
    'e.txt': 'file',
  });

  const out = getProjectTreeForPrompt(root, {
    maxDepth: 5,
    maxEntriesPerDir: 100,
    maxTotalEntries: 3,
  });

  expect(out).toBe(
    ['Project structure:', '.', '  a.txt', '  b.txt', '  c.txt', '', '- Omitted due to total-entry limit: 2'].join(
      '\n',
    ),
  );
});

it('getProjectTreeForPrompt lists directories before files and sorts names alphabetically', () => {
  const root = buildTree({
    'zdir/nested.txt': 'file',
    'afile.txt': 'file',
  });

  const out = getProjectTreeForPrompt(root, {
    maxDepth: 5,
    maxEntriesPerDir: 100,
    maxTotalEntries: 1000,
  });

  const zdirLine = out.indexOf('  zdir/');
  const afileLine = out.indexOf('  afile.txt');
  expect(zdirLine).toBeGreaterThan(-1);
  expect(afileLine).toBeGreaterThan(zdirLine);
});

it('getProjectTreeForPrompt excludes sensitive files and always-ignored dirs but keeps always-include files', () => {
  const root = buildTree({
    '.env': 'file',
    'secret.key': 'file',
    'normal.txt': 'file',
    '.gitignore': 'file',
    'node_modules/pkg/index.js': 'file',
  });

  const out = getProjectTreeForPrompt(root, {
    maxDepth: 5,
    maxEntriesPerDir: 100,
    maxTotalEntries: 1000,
  });

  expect(out.includes('.env')).toBe(false);
  expect(out.includes('secret.key')).toBe(false);
  expect(out.includes('node_modules')).toBe(false);
  expect(out.includes('normal.txt')).toBe(true);
  expect(out.includes('.gitignore')).toBe(true);
});

it('getProjectTreeForPrompt prunes hidden directories but keeps allowlisted dotfiles at the root', () => {
  const root = buildTree({
    '.vscode/settings.json': 'file',
    '.husky/pre-commit': 'file',
    '.idea/workspace.xml': 'file',
    'src/index.ts': 'file',
    '.gitignore': 'file',
    '.env.example': 'file',
    '.local-config': 'file',
  });

  const out = getProjectTreeForPrompt(root, {
    maxDepth: 5,
    maxEntriesPerDir: 100,
    maxTotalEntries: 1000,
  });

  // Hidden directories are never navigation targets and should be pruned.
  expect(out.includes('.vscode')).toBe(false);
  expect(out.includes('.husky')).toBe(false);
  expect(out.includes('.idea')).toBe(false);
  expect(out.includes('settings.json')).toBe(false);
  expect(out.includes('pre-commit')).toBe(false);

  // Allowlisted dotfiles are still shown.
  expect(out.includes('.gitignore')).toBe(true);
  expect(out.includes('.env.example')).toBe(true);

  // Non-allowlisted hidden files are pruned too.
  expect(out.includes('.local-config')).toBe(false);

  // Regular source is unaffected.
  expect(out.includes('src/')).toBe(true);
  expect(out.includes('index.ts')).toBe(true);
});

it('getProjectTreeForPrompt prunes cross-ecosystem build/cache dirs and keeps cross-ecosystem manifests', () => {
  const root = buildTree({
    'src/main.rs': 'file',
    'target/debug/app': 'file',
    'app/__pycache__/mod.pyc': 'file',
    'app/.mypy_cache/report': 'file',
    'Cargo.toml': 'file',
    'pyproject.toml': 'file',
    'go.mod': 'file',
  });

  const out = getProjectTreeForPrompt(root, {
    maxDepth: 5,
    maxEntriesPerDir: 100,
    maxTotalEntries: 1000,
  });

  // Build output and language caches are pruned across ecosystems.
  expect(out.includes('target')).toBe(false);
  expect(out.includes('__pycache__')).toBe(false);
  expect(out.includes('.mypy_cache')).toBe(false);

  // Cross-ecosystem manifests are surfaced so the project type is obvious.
  expect(out.includes('Cargo.toml')).toBe(true);
  expect(out.includes('pyproject.toml')).toBe(true);
  expect(out.includes('go.mod')).toBe(true);
  expect(out.includes('src/')).toBe(true);
});

it('getProjectTreeForPrompt defaults to maxDepth 2 so deep tooling leaves do not dominate the tree', () => {
  const root = buildTree({
    'a/b/c/deep.txt': 'file',
    'a/top.txt': 'file',
  });

  // No maxDepth option: the default should cap recursion at depth 2, so the
  // depth-3 `c/` directory is never entered and only `b/` gets an ellipsis.
  const out = getProjectTreeForPrompt(root, {
    maxEntriesPerDir: 100,
    maxTotalEntries: 1000,
  });

  expect(out.includes('a/')).toBe(true);
  expect(out.includes('b/')).toBe(true);
  expect(out.includes('c/')).toBe(false);
  expect(out.includes('deep.txt')).toBe(false);
  expect(out.includes('top.txt')).toBe(true);
});
