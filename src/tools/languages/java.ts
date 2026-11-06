import path from 'path';
import { LanguageProvider, Outline, ImportEntry, ExportEntry, DeclEntry, DeclarationKind } from './types.js';
import { escapeRegExp, normalizeRelativePath, lineNumberAt, fileExists } from './utils.js';

function* extractImportEntries(source: string): Generator<ImportEntry> {
  const regex = /\bimport\s+(?:static\s+)?([\w.*]+)\s*;/g;
  let match;
  while ((match = regex.exec(source)) !== null) {
    const specifier = match[1];
    const parts = specifier.split('.');
    const name = parts[parts.length - 1];
    yield {
      specifier,
      names: name ? [name] : [],
      line: lineNumberAt(source, match.index),
    };
  }
}

function parseJavaDeclaration(line: string, lineNumber: number): DeclEntry | null {
  // Class, interface, enum, record
  const classMatch = line.match(
    /^\s*(public|protected|private)?\s*(?:static\s+)?(?:final\s+)?(?:abstract\s+)?(?:sealed\s+)?(class|interface|enum|record)\s+([A-Za-z_$][\w$]*)/,
  );
  if (classMatch) {
    const visibility = classMatch[1];
    const kind = classMatch[2] as DeclarationKind;
    const name = classMatch[3];
    return {
      name,
      kind,
      line: lineNumber,
      exported: visibility === 'public',
    };
  }

  const excludedReturnTypes = new Set([
    'public',
    'protected',
    'private',
    'static',
    'final',
    'abstract',
    'class',
    'interface',
    'enum',
  ]);

  const excludedNames = new Set([
    'if',
    'for',
    'while',
    'switch',
    'catch',
    'synchronized',
    'return',
    'throw',
    'new',
    'assert',
    'else',
    'try',
    'finally',
    'this',
    'super',
  ]);

  // Method
  const methodMatch = line.match(
    /^\s*(public|protected|private)?(?:\s+(?:static|final|abstract|synchronized|default|native))*?\s+(?:<[\w\s,<>?[\]]+>\s+)?([\w<>?[\].,]+)\s+([A-Za-z_$][\w$]*)\s*\(/,
  );
  if (methodMatch) {
    const visibility = methodMatch[1];
    const returnType = methodMatch[2];
    const name = methodMatch[3];

    if (!excludedNames.has(name) && !excludedReturnTypes.has(returnType) && !excludedNames.has(returnType)) {
      return {
        name,
        kind: 'method',
        line: lineNumber,
        exported: visibility === 'public',
      };
    }
  }

  // Constructor (allow without visibility modifier — package-private constructor)
  const constructorMatch = line.match(/^\s*(public|protected|private)?\s+([A-Za-z_$][\w$]*)\s*\(/);
  if (!constructorMatch) {
    // Also try without required whitespace after visibility (package-private)
    const pkgPrivateMatch = line.match(/^\s*([A-Z][A-Za-z_$][\w$]*)\s*\(/);
    if (pkgPrivateMatch) {
      const name = pkgPrivateMatch[1];
      if (!excludedNames.has(name) && !excludedReturnTypes.has(name)) {
        return {
          name,
          kind: 'method',
          line: lineNumber,
          exported: false,
        };
      }
    }
  }
  if (constructorMatch) {
    const visibility = constructorMatch[1];
    const name = constructorMatch[2];

    if (!excludedNames.has(name) && !excludedReturnTypes.has(name)) {
      return {
        name,
        kind: 'method',
        line: lineNumber,
        exported: visibility === 'public',
      };
    }
  }

  return null;
}

export function extractJavaOutline(source: string): Outline {
  const imports = [...extractImportEntries(source)].sort((a, b) => a.line - b.line);
  const decls: DeclEntry[] = [];
  const lines = source.split('\n');

  for (const [index, line] of lines.entries()) {
    const decl = parseJavaDeclaration(line, index + 1);
    if (decl) {
      decls.push(decl);
    }
  }

  const exports: ExportEntry[] = decls
    .filter((d) => d.exported)
    .map((d) => ({ name: d.name, kind: d.kind, line: d.line }));

  return { imports, exports, decls };
}

function buildJavaTestPatterns(filePath: string): { forSource: string[] } {
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  const forSource = [
    normalizeRelativePath(path.join(dir, `${base}Test${ext}`)),
    normalizeRelativePath(path.join(dir, `${base}Spec${ext}`)),
  ];
  return { forSource };
}

export async function resolveJavaImport(specifier: string, _fromPath: string, root: string): Promise<string | null> {
  // Java uses fully-qualified names, not relative paths
  if (specifier.startsWith('.') || specifier.startsWith('/')) {
    return null;
  }
  // Try to resolve the fully-qualified name to a file path
  // e.g. com.example.Foo -> com/example/Foo.java
  const relativePath = specifier.replace(/\./g, '/') + '.java';
  const candidate = path.resolve(root, relativePath);
  if (await fileExists(candidate)) {
    return normalizeRelativePath(path.relative(root, candidate));
  }
  // Also try under src/ (Maven/Gradle convention)
  const srcCandidate = path.resolve(root, 'src', relativePath);
  if (await fileExists(srcCandidate)) {
    return normalizeRelativePath(path.relative(root, srcCandidate));
  }
  return null;
}

export const javaProvider: LanguageProvider = {
  language: 'java',
  extensions: ['.java'],
  matches: (filePath) => path.extname(filePath) === '.java',
  declarationPatterns: (symbol) => [
    `\\b(class|interface|enum|record)\\s+${escapeRegExp(symbol)}\\b`,
    `\\b${escapeRegExp(symbol)}\\s*\\(`,
  ],
  classifyMatch: (line, symbol) => {
    const classMatch = line.match(new RegExp(`\\b(class|interface|enum|record)\\s+${escapeRegExp(symbol)}\\b`));
    if (classMatch) {
      const isPublic = /\bpublic\b/.test(line);
      return {
        kind: classMatch[1] as DeclarationKind,
        exported: isPublic,
      };
    }

    const methodMatch = line.match(new RegExp(`\\b${escapeRegExp(symbol)}\\s*\\(`));
    if (methodMatch) {
      const isPublic = /\bpublic\b/.test(line);
      const isControl =
        /(if|for|while|switch|catch|synchronized|return|throw|new|assert|else|try|finally|this|super)/.test(line);
      if (!isControl) {
        return {
          kind: 'method',
          exported: isPublic,
        };
      }
    }

    return { kind: 'unknown', exported: false };
  },
  extractOutline: extractJavaOutline,
  resolveImport: resolveJavaImport,
  testPatterns: buildJavaTestPatterns,
};
