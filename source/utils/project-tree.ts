import fs from 'fs';
import path from 'path';
import { default as createIgnore, type Ignore } from 'ignore';

export type ProjectTreeOptions = {
  maxDepth?: number;
  maxEntriesPerDir?: number;
  maxTotalEntries?: number;
  includeFiles?: boolean;
  ignoredNames?: Set<string>;
};

// Non-hidden build output, caches, and OS noise across ecosystems. Hidden
// directories (`.idea`, `.vscode`, `.github`, `.gradle`, `.venv`, …) are pruned
// separately by isPrunedHiddenEntry, so they are not duplicated here.
const ALWAYS_IGNORE = [
  // Node / JS
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  '.turbo',
  // Python
  '__pycache__',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  '.tox',
  'venv',
  // Rust / JVM / mobile
  'target',
  '.gradle',
  'Pods',
  'DerivedData',
  '.dart_tool',
  // OS noise
  '.DS_Store',
  'Thumbs.db',
  '.cache',
];

const ALWAYS_INCLUDE = new Set([
  // Docs
  'README.md',
  'readme.md',
  'README.rst',
  'README.txt',
  // JS / TS
  'package.json',
  'tsconfig.json',
  // Python
  'pyproject.toml',
  'setup.py',
  'setup.cfg',
  'requirements.txt',
  // Rust
  'Cargo.toml',
  // Go
  'go.mod',
  // JVM
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  // Ruby / C/C++ / Elixir / PHP / Swift
  'Gemfile',
  'Rakefile',
  'CMakeLists.txt',
  'Makefile',
  'mix.exs',
  'composer.json',
  'Package.swift',
  // Config
  '.gitignore',
  '.env.example',
  '.editorconfig',
]);

const SENSITIVE_PATTERNS = [/^\.env$/, /^\.env\./, /secret/i, /private/i, /credential/i, /token/i];

function isSensitiveFile(name: string) {
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(name));
}

// Leading-dot directories are IDE/CI/agent/cache state (`.idea`, `.vscode`,
// `.github`, `.husky`, `.claude`, `.agents`, `.next`, `.gradle`, `.venv`, …)
// and are never useful navigation targets. Hidden *files* are still shown when
// they are in ALWAYS_INCLUDE (`.gitignore`, `.env.example`, …); all other
// hidden files are pruned. This single rule avoids chasing every new tool's
// dot-directory by name across ecosystems.
function isPrunedHiddenEntry(name: string, isDirectory: boolean) {
  if (!name.startsWith('.')) return false;
  if (isDirectory) return true;
  return !ALWAYS_INCLUDE.has(name);
}

function createProjectIgnore(cwd: string) {
  const ig = (createIgnore as unknown as () => Ignore)();

  ig.add(ALWAYS_IGNORE);

  const gitignorePath = path.join(cwd, '.gitignore');

  try {
    if (fs.existsSync(gitignorePath)) {
      ig.add(fs.readFileSync(gitignorePath, 'utf8'));
    }
  } catch {
    // If .gitignore cannot be read, continue with default ignores.
  }

  // Note: ALWAYS_INCLUDE precedence is enforced upstream in the walk filter,
  // which short-circuits allowlisted entries to "keep" before this is called.
  return {
    ignores(relativePath: string) {
      return ig.ignores(relativePath.split(path.sep).join('/'));
    },
  };
}

export function getProjectTreeForPrompt(cwd: string, options: ProjectTreeOptions = {}): string {
  const { maxDepth = 2, maxEntriesPerDir = 10, maxTotalEntries = 100, includeFiles = true } = options;

  const INDENT = '  ';

  let totalEntries = 0;
  // Entries that fit within the per-directory cap but could not be rendered
  // because the global `maxTotalEntries` budget was exhausted. Reported once in
  // the footer. Per-directory cap truncation is surfaced inline as
  // `... (N more)` markers instead, so the two kinds of omissions are never
  // conflated in a single number.
  let omittedByTotal = 0;

  const projectIgnore = createProjectIgnore(cwd);

  function walk(dir: string, depth: number): string[] {
    if (totalEntries >= maxTotalEntries) return [];

    let entries: fs.Dirent[];

    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e: any) {
      return [`[failed to read: ${e.message}]`];
    }

    const filtered = entries
      .filter((entry) => {
        const absolutePath = path.join(dir, entry.name);
        const relativePath = path.relative(cwd, absolutePath).split(path.sep).join('/');

        // An explicitly allowlisted entry is always shown — the allowlist is the
        // authoritative "keep" decision and wins over hidden-pruning,
        // sensitive-name pruning, and .gitignore. This lets `.env.example`
        // (a safe template) survive the `/^\.env\./` sensitive pattern.
        if (ALWAYS_INCLUDE.has(entry.name)) {
          return true;
        }

        if (isPrunedHiddenEntry(entry.name, entry.isDirectory())) {
          return false;
        }

        if (isSensitiveFile(entry.name)) {
          return false;
        }

        if (projectIgnore.ignores(relativePath)) {
          return false;
        }

        if (!includeFiles && !entry.isDirectory()) {
          return false;
        }

        return true;
      })
      .sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) return -1;
        if (!a.isDirectory() && b.isDirectory()) return 1;
        return a.name.localeCompare(b.name);
      });

    if (filtered.length === 0) return [];

    const shown = filtered.slice(0, maxEntriesPerDir);
    const perDirOmitted = Math.max(0, filtered.length - shown.length);

    const lines: string[] = [];
    const indent = INDENT.repeat(depth);

    // Depth-first rendering: each directory's children are emitted immediately
    // after the directory entry and before any later siblings. This keeps the
    // visual nesting correct — a child is always indented one level deeper
    // than its parent and appears directly beneath it.
    let budgetReached = false;
    for (let index = 0; index < shown.length; index++) {
      if (totalEntries >= maxTotalEntries) {
        omittedByTotal += shown.length - index;
        budgetReached = true;
        break;
      }

      const entry = shown[index];
      totalEntries++;

      const displayName = entry.isDirectory() ? `${entry.name}/` : entry.name;
      lines.push(`${indent}${displayName}`);

      if (entry.isDirectory()) {
        if (depth >= maxDepth) {
          // Depth-termination marker — not an omitted entry, just signals
          // that this directory has unlisted contents.
          lines.push(`${indent}${INDENT}…`);
        } else {
          lines.push(...walk(path.join(dir, entry.name), depth + 1));
          if (totalEntries >= maxTotalEntries) {
            budgetReached = true;
          }
        }
      }
    }

    // Surface per-directory truncation inline so the reader can see exactly
    // which directory was capped (and by how much). Budget cuts are reported
    // separately via the footer, so we never mix the two counts.
    if (!budgetReached && perDirOmitted > 0) {
      lines.push(`${indent}... (${perDirOmitted} more)`);
    }

    return lines;
  }

  try {
    const lines = ['Project structure:', '.', ...walk(cwd, 1), ''];

    if (omittedByTotal > 0) {
      lines.push(`- Omitted due to total-entry limit: ${omittedByTotal}`);
    }

    return lines.join('\n');
  } catch (e: any) {
    return `Project structure:\n[failed to read ${cwd}: ${e.message}]`;
  }
}
