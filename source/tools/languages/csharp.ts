import path from 'path';
import { LanguageProvider, Outline, ImportEntry, ExportEntry, DeclEntry, DeclarationKind } from './types.js';
import { escapeRegExp, normalizeRelativePath, lineNumberAt, fileExists } from './utils.js';

function* extractImportEntries(source: string): Generator<ImportEntry> {
  // global using
  const globalRegex = /\bglobal\s+using\s+(?:static\s+)?(?:[\w_$]+\s*=\s*)?([\w.]+)\s*;/g;
  let match;
  while ((match = globalRegex.exec(source)) !== null) {
    const specifier = match[1];
    const parts = specifier.split('.');
    const name = parts[parts.length - 1];
    yield {
      specifier,
      names: name ? [name] : [],
      line: lineNumberAt(source, match.index),
    };
  }
  // regular using
  const regex = /\busing\s+(?:static\s+)?(?:(?<alias>[\w_$]+)\s*=\s*)?(?<ns>[\w.]+)\s*;/g;
  while ((match = regex.exec(source)) !== null) {
    const specifier = match.groups!.ns;
    const alias = match.groups!.alias;
    const name = alias || specifier.split('.').pop() || '';
    yield {
      specifier,
      names: name ? [name] : [],
      line: lineNumberAt(source, match.index),
    };
  }
}

function parseCsharpDeclaration(line: string, lineNumber: number): DeclEntry | null {
  // Class, interface, struct, enum
  const classMatch = line.match(
    /^\s*(public|protected|private|internal|protected\s+internal|private\s+protected)?\s*(?:static\s+)?(?:partial\s+)?(?:readonly\s+)?(?:ref\s+)?(?:record\s+)?(class|interface|struct|enum|record)\s+([A-Za-z_$][\w$]*)/,
  );
  if (!classMatch) {
    // Also try standalone record (C# 9 positional syntax: public record Foo(int X);)
    const recordMatch = line.match(
      /^\s*(public|protected|private|internal|protected\s+internal|private\s+protected)?\s*record\s+([A-Za-z_$][\w$]*)\s*\(/,
    );
    if (recordMatch) {
      const visibility = recordMatch[1];
      const name = recordMatch[2];
      const excludedNames = new Set([
        'if',
        'for',
        'while',
        'switch',
        'catch',
        'return',
        'throw',
        'new',
        'assert',
        'else',
        'try',
        'finally',
        'using',
        'lock',
        'typeof',
        'sizeof',
        'nameof',
        'this',
        'base',
      ]);
      if (!excludedNames.has(name)) {
        return {
          name,
          kind: 'class',
          line: lineNumber,
          exported: visibility === 'public',
        };
      }
    }
  }
  if (classMatch) {
    const visibility = classMatch[1];
    const rawKind = classMatch[2];
    const kind = rawKind === 'struct' ? 'class' : (rawKind as DeclarationKind);
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
    'internal',
    'static',
    'readonly',
    'virtual',
    'override',
    'async',
    'unsafe',
    'extern',
    'class',
    'interface',
    'struct',
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
    'using',
    'lock',
    'typeof',
    'sizeof',
    'nameof',
    'this',
    'base',
  ]);

  // Method
  const methodMatch = line.match(
    /^\s*(public|protected|private|internal|protected\s+internal|private\s+protected)?(?:\s+(?:static|sealed|abstract|virtual|override|async|unsafe|extern|new|partial))*?\s+(?:<[\w\s,<>?\[\]]+>\s+)?([\w<>?\[\].,_]+)\s+([A-Za-z_$][\w$]*)\s*\(/,
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

  // Constructor
  const constructorMatch = line.match(
    /^\s*(public|protected|private|internal|protected\s+internal|private\s+protected)?\s+([A-Za-z_$][\w$]*)\s*\(/,
  );
  if (constructorMatch) {
    const visibility = constructorMatch[1];
    const name = constructorMatch[2];

    if (!excludedNames.has(name) && !excludedReturnTypes.has(name) && visibility) {
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

export function extractCsharpOutline(source: string): Outline {
  const imports = [...extractImportEntries(source)].sort((a, b) => a.line - b.line);
  const decls: DeclEntry[] = [];
  const lines = source.split('\n');

  for (const [index, line] of lines.entries()) {
    const decl = parseCsharpDeclaration(line, index + 1);
    if (decl) {
      decls.push(decl);
    }
  }

  const exports: ExportEntry[] = decls
    .filter((d) => d.exported)
    .map((d) => ({ name: d.name, kind: d.kind, line: d.line }));

  return { imports, exports, decls };
}

function buildCsharpTestPatterns(filePath: string): { forSource: string[] } {
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  const forSource = [
    normalizeRelativePath(path.join(dir, `${base}Tests${ext}`)),
    normalizeRelativePath(path.join(dir, `${base}Test${ext}`)),
  ];
  return { forSource };
}

export async function resolveCsharpImport(specifier: string, _fromPath: string, root: string): Promise<string | null> {
  // C# uses namespace-based imports, not relative file paths
  if (specifier.startsWith('.') || specifier.startsWith('/')) {
    return null;
  }
  // Try to resolve namespace to a file path
  const relativePath = specifier.replace(/\./g, '/') + '.cs';
  const candidate = path.resolve(root, relativePath);
  if (await fileExists(candidate)) {
    return normalizeRelativePath(path.relative(root, candidate));
  }
  return null;
}

export const csharpProvider: LanguageProvider = {
  language: 'csharp',
  extensions: ['.cs'],
  matches: (filePath) => path.extname(filePath) === '.cs',
  declarationPatterns: (symbol) => [
    `\\b(class|interface|struct|enum|record)\\s+${escapeRegExp(symbol)}\\b`,
    `\\b${escapeRegExp(symbol)}\\s*\\(`,
  ],
  classifyMatch: (line, symbol) => {
    const classMatch = line.match(new RegExp(`\\b(class|interface|struct|enum|record)\\s+${escapeRegExp(symbol)}\\b`));
    if (classMatch) {
      const isPublic = /\bpublic\b/.test(line);
      const kind = classMatch[1] === 'struct' ? 'class' : (classMatch[1] as DeclarationKind);
      return {
        kind,
        exported: isPublic,
      };
    }

    const methodMatch = line.match(new RegExp(`\\b${escapeRegExp(symbol)}\\s*\\(`));
    if (methodMatch) {
      const isPublic = /\bpublic\b/.test(line);
      const isControl = /\b(if|for|while|switch|catch|synchronized|return|throw|new|assert|using|lock)\b/.test(line);
      if (!isControl) {
        return {
          kind: 'method',
          exported: isPublic,
        };
      }
    }

    return { kind: 'unknown', exported: false };
  },
  extractOutline: extractCsharpOutline,
  resolveImport: resolveCsharpImport,
  testPatterns: buildCsharpTestPatterns,
};
