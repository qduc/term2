import path from 'path';
import { LanguageProvider, Outline } from './types.js';
import { escapeRegExp, normalizeRelativePath, fileExists } from './utils.js';

function extractPythonOutline(source: string): Outline {
  const lines = source.split('\n');
  const imports: any[] = [];
  const decls: any[] = [];
  const exports: any[] = [];

  let inFromImportBlock = false;
  let fromImportSpecifier = '';
  let fromImportLine = 0;
  let fromImportNames: string[] = [];

  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    const cleanLine = line.replace(/#.*$/, '');
    const trimmed = cleanLine.trim();

    if (!trimmed) continue;

    // Handle multi-line from ... import (
    if (inFromImportBlock) {
      if (trimmed.includes(')')) {
        const contentBeforeParen = trimmed.split(')')[0];
        const names = contentBeforeParen
          .split(',')
          .map((n) => {
            const parts = n.trim().split(/\s+as\s+/);
            return (parts[1] || parts[0]).trim();
          })
          .filter(Boolean);
        fromImportNames.push(...names);
        imports.push({
          specifier: fromImportSpecifier,
          names: fromImportNames,
          line: fromImportLine,
        });
        inFromImportBlock = false;
        fromImportSpecifier = '';
        fromImportNames = [];
      } else {
        const names = trimmed
          .split(',')
          .map((n) => {
            const parts = n.trim().split(/\s+as\s+/);
            return (parts[1] || parts[0]).trim();
          })
          .filter(Boolean);
        fromImportNames.push(...names);
      }
      continue;
    }

    // Check if it's the start of from ... import (
    const fromImportStartParenMatch = cleanLine.match(/^\s*from\s+([\w.]+)\s+import\s*\(\s*([^)]*)$/);
    if (fromImportStartParenMatch) {
      inFromImportBlock = true;
      fromImportSpecifier = fromImportStartParenMatch[1];
      fromImportLine = lineNumber;
      const initialNames = fromImportStartParenMatch[2]
        .split(',')
        .map((n) => {
          const parts = n.trim().split(/\s+as\s+/);
          return (parts[1] || parts[0]).trim();
        })
        .filter(Boolean);
      fromImportNames = initialNames;
      continue;
    }

    // Single line from ... import ...
    const fromImportMatch = cleanLine.match(/^\s*from\s+([\w.]+)\s+import\s+(.+)$/);
    if (fromImportMatch) {
      const specifier = fromImportMatch[1];
      const names = fromImportMatch[2]
        .split(',')
        .map((n) => {
          const parts = n.trim().split(/\s+as\s+/);
          return (parts[1] || parts[0]).trim();
        })
        .filter(Boolean);
      imports.push({
        specifier,
        names,
        line: lineNumber,
      });
      continue;
    }

    // Basic import statement
    const importMatch = cleanLine.match(/^\s*import\s+(.+)$/);
    if (importMatch) {
      const entries = importMatch[1]
        .split(',')
        .map((item) => {
          const parts = item.trim().split(/\s+as\s+/);
          const specifier = parts[0].trim();
          const name = (parts[1] || parts[0]).trim();
          return { specifier, name };
        })
        .filter((e) => e.specifier);

      for (const entry of entries) {
        imports.push({
          specifier: entry.specifier,
          names: [entry.name],
          line: lineNumber,
        });
      }
      continue;
    }

    // Declarations (must start at column 0 to be top-level in Python)
    if (/^\s/.test(line)) continue;

    // Class definition
    const classMatch = cleanLine.match(/^class\s+([A-Za-z_][\w_]*)\b/);
    if (classMatch) {
      decls.push({
        name: classMatch[1],
        kind: 'class',
        line: lineNumber,
        exported: false,
      });
      continue;
    }

    // Function definition
    const defMatch = cleanLine.match(/^(async\s+)?def\s+([A-Za-z_][\w_]*)\b/);
    if (defMatch) {
      const kind = defMatch[1] ? 'async function' : 'function';
      decls.push({
        name: defMatch[2],
        kind,
        line: lineNumber,
        exported: false,
      });
      continue;
    }
  }

  return { imports, exports, decls };
}

export async function resolvePythonImport(specifier: string, fromPath: string, root: string): Promise<string | null> {
  const fromDir = path.dirname(path.join(root, fromPath));
  // Try the specifier directly
  const candidate = path.resolve(fromDir, specifier.endsWith('.py') ? specifier : `${specifier}.py`);
  if (await fileExists(candidate)) {
    return normalizeRelativePath(path.relative(root, candidate));
  }
  // Try as a package (specifier/__init__.py)
  const pkgCandidate = path.join(fromDir, specifier, '__init__.py');
  if (await fileExists(pkgCandidate)) {
    return normalizeRelativePath(path.relative(root, pkgCandidate));
  }
  // For relative imports like `.`, `..`, resolve accordingly
  if (specifier === '.' || specifier.startsWith('.')) {
    const levels = specifier.split('.').length - 1;
    let dir = fromDir;
    for (let i = 0; i < levels; i++) {
      dir = path.dirname(dir);
    }
    const pkgInit = path.join(dir, '__init__.py');
    if (await fileExists(pkgInit)) {
      return normalizeRelativePath(path.relative(root, pkgInit));
    }
  }
  return null;
}

export function buildPythonTestPatterns(filePath: string): { forSource: string[] } {
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  const forSource = [
    normalizeRelativePath(path.join(dir, `test_${base}.py`)),
    normalizeRelativePath(path.join(dir, `${base}_test.py`)),
    normalizeRelativePath(path.join('tests', `test_${base}.py`)),
    normalizeRelativePath(path.join('tests', `${base}_test.py`)),
  ];
  return { forSource };
}

export const pythonProvider: LanguageProvider = {
  language: 'python',
  extensions: ['.py'],
  matches: (filePath) => path.extname(filePath) === '.py',
  declarationPatterns: (symbol) => [
    `^\\s*(async\\s+)?def\\s+${escapeRegExp(symbol)}\\b`,
    `^\\s*class\\s+${escapeRegExp(symbol)}\\b`,
  ],
  classifyMatch: (line) => ({
    kind: /^\s*class\b/.test(line) ? 'class' : /^\s*async\s+def\b/.test(line) ? 'async function' : 'function',
    exported: false,
  }),
  extractOutline: extractPythonOutline,
  resolveImport: resolvePythonImport,
  testPatterns: buildPythonTestPatterns,
};
