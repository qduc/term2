import path from 'path';
import { LanguageProvider, Outline, DeclarationKind, ImportEntry, DeclEntry, ExportEntry } from './types.js';
import { escapeRegExp, normalizeRelativePath, fileExists } from './utils.js';

function extractGoOutline(source: string): Outline {
  const lines = source.split('\n');
  const imports: ImportEntry[] = [];
  const decls: DeclEntry[] = [];
  const exports: ExportEntry[] = [];
  let inImportBlock = false;
  let inConstBlock = false;
  let inVarBlock = false;
  let inTypeBlock = false;

  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    const cleanLine = line.replace(/\/\/.*$/, '');
    const trimmed = cleanLine.trim();

    if (!trimmed) continue;

    // Parse imports
    if (/^\s*import\s*\(/.test(cleanLine)) {
      inImportBlock = true;
      continue;
    }
    if (inImportBlock && /^\s*\)/.test(cleanLine)) {
      inImportBlock = false;
      continue;
    }
    if (inImportBlock) {
      const m = cleanLine.match(/^\s*(?:([A-Za-z_][\w_]*)\s+)?['"]([^'"]+)['"]/);
      if (m) {
        imports.push({
          specifier: m[2],
          names: m[1] ? [m[1]] : [],
          line: lineNumber,
        });
      }
      continue;
    }

    const singleImportMatch = cleanLine.match(/^\s*import\s+(?:([A-Za-z_][\w_]*)\s+)?['"]([^'"]+)['"]/);
    if (singleImportMatch) {
      imports.push({
        specifier: singleImportMatch[2],
        names: singleImportMatch[1] ? [singleImportMatch[1]] : [],
        line: lineNumber,
      });
      continue;
    }

    // Check block declarations
    if (/^const\s*\(/.test(cleanLine)) {
      inConstBlock = true;
      continue;
    }
    if (/^var\s*\(/.test(cleanLine)) {
      inVarBlock = true;
      continue;
    }
    if (/^type\s*\(/.test(cleanLine)) {
      inTypeBlock = true;
      continue;
    }
    if (inConstBlock && /^\)/.test(trimmed)) {
      inConstBlock = false;
      continue;
    }
    if (inVarBlock && /^\)/.test(trimmed)) {
      inVarBlock = false;
      continue;
    }
    if (inTypeBlock && /^\)/.test(trimmed)) {
      inTypeBlock = false;
      continue;
    }

    if (inConstBlock) {
      const match = cleanLine.match(/^\s*([A-Za-z_][\w_]*)\b/);
      if (match) {
        const name = match[1];
        const exported = /^[A-Z]/.test(name);
        const decl: DeclEntry = { name, kind: 'const', line: lineNumber, exported };
        decls.push(decl);
        if (exported) exports.push({ name, kind: 'const', line: lineNumber });
      }
      continue;
    }
    if (inVarBlock) {
      const match = cleanLine.match(/^\s*([A-Za-z_][\w_]*)\b/);
      if (match) {
        const name = match[1];
        const exported = /^[A-Z]/.test(name);
        const decl: DeclEntry = { name, kind: 'var', line: lineNumber, exported };
        decls.push(decl);
        if (exported) exports.push({ name, kind: 'var', line: lineNumber });
      }
      continue;
    }
    if (inTypeBlock) {
      const match = cleanLine.match(/^\s*([A-Za-z_][\w_]*)\b/);
      if (match) {
        const name = match[1];
        const exported = /^[A-Z]/.test(name);
        const isInterface = cleanLine.includes('interface');
        const kind: DeclarationKind = isInterface ? 'interface' : 'type';
        const decl: DeclEntry = { name, kind, line: lineNumber, exported };
        decls.push(decl);
        if (exported) exports.push({ name, kind, line: lineNumber });
      }
      continue;
    }

    // Parse top-level declarations (only column 0 / non-whitespace start)
    if (/^\s/.test(line)) continue;

    // Check function: func [receiver] Name(...)
    const funcMatch = cleanLine.match(/^func\s+(?:\([^)]+\)\s*)?([A-Za-z_][\w_]*)\b/);
    if (funcMatch) {
      const name = funcMatch[1];
      const isMethod = /^\s*func\s*\([^)]+\)/.test(cleanLine);
      const kind = isMethod ? 'method' : 'function';
      const exported = /^[A-Z]/.test(name);
      const decl: DeclEntry = { name, kind, line: lineNumber, exported };
      decls.push(decl);
      if (exported) {
        exports.push({ name, kind, line: lineNumber });
      }
      continue;
    }

    // Check type: type Name ...
    const typeMatch = cleanLine.match(/^type\s+([A-Za-z_][\w_]*)\b/);
    if (typeMatch) {
      const name = typeMatch[1];
      const kind = /^type\s+[A-Za-z_][\w_]*\s+interface\b/.test(cleanLine) ? 'interface' : 'type';
      const exported = /^[A-Z]/.test(name);
      const decl: DeclEntry = { name, kind, line: lineNumber, exported };
      decls.push(decl);
      if (exported) {
        exports.push({ name, kind, line: lineNumber });
      }
      continue;
    }

    // Check const: const Name ...
    const constMatch = cleanLine.match(/^const\s+([A-Za-z_][\w_]*)\b/);
    if (constMatch) {
      const name = constMatch[1];
      const exported = /^[A-Z]/.test(name);
      const decl: DeclEntry = { name, kind: 'const', line: lineNumber, exported };
      decls.push(decl);
      if (exported) {
        exports.push({ name, kind: 'const', line: lineNumber });
      }
      continue;
    }

    // Check var: var Name ...
    const varMatch = cleanLine.match(/^var\s+([A-Za-z_][\w_]*)\b/);
    if (varMatch) {
      const name = varMatch[1];
      const exported = /^[A-Z]/.test(name);
      const decl: DeclEntry = { name, kind: 'var', line: lineNumber, exported };
      decls.push(decl);
      if (exported) {
        exports.push({ name, kind: 'var', line: lineNumber });
      }
      continue;
    }
  }

  return { imports, exports, decls };
}

export async function resolveGoImport(specifier: string, fromPath: string, root: string): Promise<string | null> {
  // Standard library and external modules — can't resolve to a single file
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
    return null;
  }
  const fromDir = path.dirname(path.join(root, fromPath));
  const candidate = path.resolve(fromDir, specifier);
  const goFile = candidate.endsWith('.go') ? candidate : `${candidate}.go`;
  if (await fileExists(goFile)) {
    return normalizeRelativePath(path.relative(root, goFile));
  }
  return null;
}

export function buildGoTestPatterns(filePath: string): { forSource: string[] } {
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  const forSource = [normalizeRelativePath(path.join(dir, `${base}_test.go`))];
  return { forSource };
}

export const goProvider: LanguageProvider = {
  language: 'go',
  extensions: ['.go'],
  matches: (filePath) => path.extname(filePath) === '.go',
  declarationPatterns: (symbol) => [
    `^\\s*func\\s+(\\([^)]*\\)\\s*)?${escapeRegExp(symbol)}\\b`,
    `^\\s*type\\s+${escapeRegExp(symbol)}\\b`,
    `^\\s*const\\s+${escapeRegExp(symbol)}\\b`,
    `^\\s*var\\s+${escapeRegExp(symbol)}\\b`,
  ],
  classifyMatch: (line, symbol) => {
    if (!symbol) return { kind: 'unknown', exported: false };
    const trimmed = line.trim();
    let kind: DeclarationKind = 'unknown';
    if (/^func\b/.test(trimmed)) {
      kind = /^func\s*\([^)]+\)/.test(trimmed) ? 'method' : 'function';
    } else if (/^type\b/.test(trimmed)) {
      kind = /^type\s+[A-Za-z_][\w_]*\s+interface\b/.test(trimmed) ? 'interface' : 'type';
    } else if (/^const\b/.test(trimmed)) {
      kind = 'const';
    } else if (/^var\b/.test(trimmed)) {
      kind = 'var';
    }
    return {
      kind,
      exported: /^[A-Z]/.test(symbol),
    };
  },
  extractOutline: extractGoOutline,
  resolveImport: resolveGoImport,
  testPatterns: buildGoTestPatterns,
};
