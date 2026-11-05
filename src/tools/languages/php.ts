import path from 'path';
import { LanguageProvider, Outline, ImportEntry, ExportEntry, DeclEntry, DeclarationKind } from './types.js';
import { escapeRegExp, normalizeRelativePath, fileExists } from './utils.js';

export function extractPHPOutline(source: string): Outline {
  const imports: ImportEntry[] = [];
  const exports: ExportEntry[] = [];
  const decls: DeclEntry[] = [];
  const lines = source.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNumber = i + 1;
    const trimmed = line.trim();

    // Skip comments
    if (trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('/*')) {
      continue;
    }

    // Match namespace: namespace Foo\Bar; (design choice: treat as import for file resolution)
    const namespaceMatch = trimmed.match(/^namespace\s+([^;{\s]+)/);
    if (namespaceMatch) {
      imports.push({
        specifier: namespaceMatch[1],
        names: [],
        line: lineNumber,
      });
    }

    // Match use for imports (skip indented use — that's trait application inside classes)
    if (!/^\s{2,}/.test(line)) {
      const useMatch = trimmed.match(/^use\s+([^;]+)/);
      if (useMatch) {
        imports.push({
          specifier: useMatch[1].trim(),
          names: [],
          line: lineNumber,
        });
      }
    }

    // Match include/require: require 'vendor/autoload.php';
    const fileIncludeMatch = line.match(/\b(include|include_once|require|require_once)\b\s*\(?\s*['"]([^'"]+)['"]/);
    if (fileIncludeMatch) {
      imports.push({
        specifier: fileIncludeMatch[2],
        names: [],
        line: lineNumber,
      });
    }

    // Match class, interface, trait, enum, function declarations
    const classMatch = trimmed.match(/^(?:(?:abstract|final|readonly)\s+)*class\s+([A-Za-z0-9_]+)/);
    const interfaceMatch = trimmed.match(/^interface\s+([A-Za-z0-9_]+)/);
    const traitMatch = trimmed.match(/^trait\s+([A-Za-z0-9_]+)/);
    const enumMatch = trimmed.match(/^enum\s+([A-Za-z0-9_]+)/);
    const functionMatch = trimmed.match(
      /^(?:(?:public|protected|private|static|final|abstract)\s+)*function\s+([A-Za-z0-9_]+)/,
    );

    // Determine exported status based on visibility for methods, always true for top-level
    const isPublicApi = !/^\s*(private|protected)\s/.test(trimmed);

    if (classMatch) {
      const name = classMatch[1];
      decls.push({ name, kind: 'class', line: lineNumber, exported: true });
      exports.push({ name, kind: 'class', line: lineNumber });
    } else if (interfaceMatch) {
      const name = interfaceMatch[1];
      decls.push({ name, kind: 'interface', line: lineNumber, exported: true });
      exports.push({ name, kind: 'interface', line: lineNumber });
    } else if (traitMatch) {
      const name = traitMatch[1];
      decls.push({ name, kind: 'class', line: lineNumber, exported: true });
      exports.push({ name, kind: 'class', line: lineNumber });
    } else if (enumMatch) {
      const name = enumMatch[1];
      decls.push({ name, kind: 'enum', line: lineNumber, exported: true });
      exports.push({ name, kind: 'enum', line: lineNumber });
    } else if (functionMatch) {
      const name = functionMatch[1];
      decls.push({ name, kind: 'function', line: lineNumber, exported: isPublicApi });
      exports.push({ name, kind: 'function', line: lineNumber });
    }
  }

  return { imports, exports, decls };
}

export async function resolvePHPImport(specifier: string, fromPath: string, root: string): Promise<string | null> {
  const fromDir = path.dirname(path.join(root, fromPath));
  const candidate = path.resolve(fromDir, specifier.endsWith('.php') ? specifier : `${specifier}.php`);
  if (await fileExists(candidate)) {
    return normalizeRelativePath(path.relative(root, candidate));
  }
  return null;
}

export function buildPHPTestPatterns(filePath: string): { forSource: string[] } {
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  const forSource = [
    normalizeRelativePath(path.join(dir, `${base}Test.php`)),
    normalizeRelativePath(path.join('tests', `${base}Test.php`)),
    normalizeRelativePath(path.join('tests', 'Unit', `${base}Test.php`)),
    normalizeRelativePath(path.join('tests', 'Feature', `${base}Test.php`)),
  ];
  return { forSource };
}

export const phpProvider: LanguageProvider = {
  language: 'php',
  extensions: ['.php'],
  matches: (filePath) => path.extname(filePath) === '.php',
  declarationPatterns: (symbol) => [
    `^\\s*(?:(?:abstract|final|readonly)\\s+)*class\\s+${escapeRegExp(symbol)}\\b`,
    `^\\s*interface\\s+${escapeRegExp(symbol)}\\b`,
    `^\\s*trait\\s+${escapeRegExp(symbol)}\\b`,
    `^\\s*enum\\s+${escapeRegExp(symbol)}\\b`,
    `\\bfunction\\s+${escapeRegExp(symbol)}\\b`,
  ],
  classifyMatch: (line, symbol) => {
    const isClass = new RegExp(`^\\s*(?:(?:abstract|final|readonly)\\s+)*class\\s+${escapeRegExp(symbol)}\\b`).test(
      line,
    );
    const isInterface = new RegExp(`^\\s*interface\\s+${escapeRegExp(symbol)}\\b`).test(line);
    const isTrait = new RegExp(`^\\s*trait\\s+${escapeRegExp(symbol)}\\b`).test(line);
    const isEnum = new RegExp(`^\\s*enum\\s+${escapeRegExp(symbol)}\\b`).test(line);
    const isFunction = new RegExp(`\\bfunction\\s+${escapeRegExp(symbol)}\\b`).test(line);

    let kind: DeclarationKind = 'unknown';
    if (isClass || isTrait) {
      kind = 'class';
    } else if (isInterface) {
      kind = 'interface';
    } else if (isEnum) {
      kind = 'enum';
    } else if (isFunction) {
      kind = 'function';
    }
    // Top-level declarations are always public; methods use 'exported' based on visibility
    const isExported = !/^\\s*(private|protected)\\s/.test(line);
    return { kind, exported: isExported };
  },
  extractOutline: extractPHPOutline,
  resolveImport: resolvePHPImport,
  testPatterns: buildPHPTestPatterns,
};
