import path from 'path';
import { LanguageProvider, Outline, DeclarationKind, DeclEntry, ExportEntry, ImportEntry } from './types.js';
import { escapeRegExp, normalizeRelativePath, fileExists } from './utils.js';

function parseRustUse(statement: string, line: number): ImportEntry | null {
  const clean = statement
    .replace(/;$/, '')
    .replace(/^(pub\s+)?use\s+/, '')
    .trim();
  if (!clean) return null;

  const braceMatch = clean.match(/^(.*?)::\{([\s\S]*?)\}$/);
  if (braceMatch) {
    const specifier = braceMatch[1].trim();
    const names = braceMatch[2]
      .split(',')
      .map((n) => n.trim())
      .filter(Boolean)
      .map((n) =>
        n
          .split(/\s+as\s+/)
          .pop()!
          .trim(),
      );
    return { specifier, names, line };
  }

  const parts = clean.split(/\s+as\s+/);
  const fullPath = parts[0].trim();
  const alias = parts[1]?.trim();

  const pathSegments = fullPath.split('::');
  const lastName = pathSegments.pop()!;
  const specifier = pathSegments.join('::') || lastName;
  const names = [alias || lastName];
  return { specifier, names, line };
}

function parseRustDeclaration(line: string, lineNumber: number): DeclEntry | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  // Skip lines that are clearly not top-level (inside impl blocks, mod blocks etc.)
  // but allow indented const/type declarations inside const/type blocks
  const match = trimmed.match(
    /^(pub(?:\([^)]+\))?\s+)?(fn|struct|enum|trait|type|const|static|mod|union|impl)\s+([A-Za-z_][\w_]*)\b/,
  );
  if (!match) return null;

  const isPublic = Boolean(match[1]);
  const rawKind = match[2];
  const name = match[3];

  let kind: DeclarationKind = 'unknown';
  if (rawKind === 'fn') kind = 'function';
  else if (rawKind === 'struct') kind = 'type';
  else if (rawKind === 'enum') kind = 'enum';
  else if (rawKind === 'trait') kind = 'interface';
  else if (rawKind === 'type') kind = 'type';
  else if (rawKind === 'const') kind = 'const';
  else if (rawKind === 'static') kind = 'const';
  else if (rawKind === 'mod') kind = 'class';
  else if (rawKind === 'union') kind = 'type';
  else if (rawKind === 'impl') return null; // impl blocks declare no named item

  return {
    name,
    kind,
    line: lineNumber,
    exported: isPublic,
  };
}

function extractRustOutline(source: string): Outline {
  const lines = source.split('\n');
  const imports: ImportEntry[] = [];
  const decls: DeclEntry[] = [];
  const exports: ExportEntry[] = [];

  let useAccumulator = '';
  let useLineNumber = 0;
  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    const cleanLine = line.replace(/\/\/.*$/, '');
    const trimmed = cleanLine.trim();

    if (useAccumulator) {
      useAccumulator += ' ' + trimmed;
      if (useAccumulator.endsWith(';')) {
        const parsed = parseRustUse(useAccumulator, useLineNumber);
        if (parsed) imports.push(parsed);
        useAccumulator = '';
      }
      continue;
    }

    if (/^(pub\s+)?use\s+/.test(trimmed)) {
      useAccumulator = trimmed;
      useLineNumber = lineNumber;
      if (useAccumulator.endsWith(';')) {
        const parsed = parseRustUse(useAccumulator, useLineNumber);
        if (parsed) imports.push(parsed);
        useAccumulator = '';
      }
    }
  }

  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    const cleanLine = line.replace(/\/\/.*$/, '');
    const decl = parseRustDeclaration(cleanLine, lineNumber);
    if (decl) {
      decls.push(decl);
      if (decl.exported) {
        exports.push({ name: decl.name, kind: decl.kind, line: decl.line });
      }
    }
  }

  return { imports, exports, decls };
}

export async function resolveRustImport(specifier: string, fromPath: string, root: string): Promise<string | null> {
  // External crates and std lib — can't resolve to a single file
  if (!specifier.startsWith('crate::') && !specifier.startsWith('self::') && !specifier.startsWith('super::')) {
    return null;
  }

  const relativePath = specifier
    .replace(/^(crate|self)::/, '')
    .replace(/super::/g, '../')
    .replace(/::/g, '/');

  const fromDir = path.dirname(path.join(root, fromPath));
  const candidate = path.resolve(fromDir, relativePath);

  // Try as a module file
  for (const name of [`${candidate}.rs`, path.join(candidate, 'mod.rs')]) {
    if (await fileExists(name)) {
      return normalizeRelativePath(path.relative(root, name));
    }
  }

  return null;
}

export function buildRustTestPatterns(filePath: string): { forSource: string[] } {
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  const forSource = [
    normalizeRelativePath(path.join(dir, `${base}_test.rs`)),
    normalizeRelativePath(path.join(dir, `${base}_spec.rs`)),
    normalizeRelativePath(path.join('tests', `${base}.rs`)),
  ];
  return { forSource };
}

export const rustProvider: LanguageProvider = {
  language: 'rust',
  extensions: ['.rs'],
  matches: (filePath) => path.extname(filePath) === '.rs',
  declarationPatterns: (symbol) => [
    `^\\s*(pub(?:\\([^)]+\\))?\\s+)?fn\\s+${escapeRegExp(symbol)}\\b`,
    `^\\s*(pub(?:\\([^)]+\\))?\\s+)?struct\\s+${escapeRegExp(symbol)}\\b`,
    `^\\s*(pub(?:\\([^)]+\\))?\\s+)?enum\\s+${escapeRegExp(symbol)}\\b`,
    `^\\s*(pub(?:\\([^)]+\\))?\\s+)?trait\\s+${escapeRegExp(symbol)}\\b`,
    `^\\s*(pub(?:\\([^)]+\\))?\\s+)?type\\s+${escapeRegExp(symbol)}\\b`,
    `^\\s*(pub(?:\\([^)]+\\))?\\s+)?(const|static)\\s+${escapeRegExp(symbol)}\\b`,
    `^\\s*(pub(?:\\([^)]+\\))?\\s+)?mod\\s+${escapeRegExp(symbol)}\\b`,
    `^\\s*(pub(?:\\([^)]+\\))?\\s+)?union\\s+${escapeRegExp(symbol)}\\b`,
  ],
  classifyMatch: (line) => {
    const trimmed = line.trim();
    const kind: DeclarationKind =
      /^pub(?:\s|\().*\bfn\b/.test(trimmed) || /^fn\b/.test(trimmed)
        ? 'function'
        : /^pub(?:\s|\().*\benum\b/.test(trimmed) || /^enum\b/.test(trimmed)
        ? 'enum'
        : /^pub(?:\s|\().*\btrait\b/.test(trimmed) || /^trait\b/.test(trimmed)
        ? 'interface'
        : /^pub(?:\s|\().*\bstruct\b/.test(trimmed) || /^struct\b/.test(trimmed)
        ? 'type'
        : /^pub(?:\s|\().*\btype\b/.test(trimmed) || /^type\b/.test(trimmed)
        ? 'type'
        : /^pub(?:\s|\().*\b(const|static)\b/.test(trimmed) || /^(const|static)\b/.test(trimmed)
        ? 'const'
        : /^pub(?:\s|\().*\bmod\b/.test(trimmed) || /^mod\b/.test(trimmed)
        ? 'class'
        : /^pub(?:\s|\().*\bunion\b/.test(trimmed) || /^union\b/.test(trimmed)
        ? 'type'
        : 'unknown';
    return { kind, exported: /^pub(?:\s|\(|\b)/.test(trimmed) };
  },
  extractOutline: extractRustOutline,
  resolveImport: resolveRustImport,
  testPatterns: buildRustTestPatterns,
};
