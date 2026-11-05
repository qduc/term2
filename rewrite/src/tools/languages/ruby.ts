import path from 'path';
import { LanguageProvider, Outline, ImportEntry, ExportEntry, DeclEntry, DeclarationKind } from './types.js';
import { escapeRegExp, normalizeRelativePath, fileExists } from './utils.js';

export function extractRubyOutline(source: string): Outline {
  const imports: ImportEntry[] = [];
  const exports: ExportEntry[] = [];
  const decls: DeclEntry[] = [];
  const lines = source.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNumber = i + 1;
    const trimmed = line.trim();

    // Skip comments
    if (trimmed.startsWith('#')) {
      continue;
    }

    // Match imports: require 'lib' or require_relative 'path'
    const importMatch = line.match(/\b(require|require_relative)\b\s*\(?\s*['"]([^'"]+)['"]\s*\)?/);
    if (importMatch) {
      imports.push({
        specifier: importMatch[2],
        names: [],
        line: lineNumber,
      });
    }

    // Match declarations: module, class, top-level method
    const moduleMatch = line.match(/^\s*module\s+([A-Za-z0-9_:]+)/);
    const classMatch = line.match(/^\s*class\s+([A-Za-z0-9_:]+)/);
    // Top-level method starts def at column 0 (no leading whitespace)
    const methodMatch = line.match(/^\s*def\s+(?:self\.)?([A-Za-z0-9_!?=]+)/);

    if (moduleMatch) {
      const name = moduleMatch[1];
      decls.push({ name, kind: 'class', line: lineNumber, exported: true });
      exports.push({ name, kind: 'class', line: lineNumber });
    } else if (classMatch) {
      const name = classMatch[1];
      decls.push({ name, kind: 'class', line: lineNumber, exported: true });
      exports.push({ name, kind: 'class', line: lineNumber });
    } else if (methodMatch) {
      const name = methodMatch[1];
      decls.push({ name, kind: 'function', line: lineNumber, exported: true });
      exports.push({ name, kind: 'function', line: lineNumber });
    }
  }

  return { imports, exports, decls };
}

export async function resolveRubyImport(specifier: string, fromPath: string, root: string): Promise<string | null> {
  const fromDir = path.dirname(path.join(root, fromPath));
  const candidate = path.resolve(fromDir, specifier.endsWith('.rb') ? specifier : `${specifier}.rb`);
  if (await fileExists(candidate)) {
    return normalizeRelativePath(path.relative(root, candidate));
  }
  return null;
}

export function buildRubyTestPatterns(filePath: string): { forSource: string[] } {
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  const forSource = [
    normalizeRelativePath(path.join(dir, `${base}_spec.rb`)),
    normalizeRelativePath(path.join(dir, `${base}_test.rb`)),
    normalizeRelativePath(path.join('spec', `${base}_spec.rb`)),
    normalizeRelativePath(path.join('test', `${base}_test.rb`)),
  ];
  return { forSource };
}

export const rubyProvider: LanguageProvider = {
  language: 'ruby',
  extensions: ['.rb'],
  matches: (filePath) => path.extname(filePath) === '.rb',
  declarationPatterns: (symbol) => [
    `^\\s*class\\s+(?:[A-Za-z0-9_:]+::)?${escapeRegExp(symbol)}\\b`,
    `^\\s*module\\s+(?:[A-Za-z0-9_:]+::)?${escapeRegExp(symbol)}\\b`,
    `^\\s*def\\s+(?:self\\.)?${escapeRegExp(symbol)}\\b`,
  ],
  classifyMatch: (line, symbol) => {
    const isClass = new RegExp(`^\\s*class\\s+(?:[A-Za-z0-9_:]+::)?${escapeRegExp(symbol)}\\b`).test(line);
    const isModule = new RegExp(`^\\s*module\\s+(?:[A-Za-z0-9_:]+::)?${escapeRegExp(symbol)}\\b`).test(line);
    const isMethod = new RegExp(`^\\s*def\\s+(?:self\\.)?${escapeRegExp(symbol)}\\b`).test(line);

    let kind: DeclarationKind = 'unknown';
    if (isClass || isModule) {
      kind = 'class';
    } else if (isMethod) {
      kind = 'function';
    }
    return { kind, exported: true };
  },
  extractOutline: extractRubyOutline,
  resolveImport: resolveRubyImport,
  testPatterns: buildRubyTestPatterns,
};
