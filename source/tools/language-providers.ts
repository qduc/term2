import path from 'path';
import * as fs from 'fs/promises';

export type DeclarationKind =
  | 'function'
  | 'async function'
  | 'class'
  | 'interface'
  | 'type'
  | 'enum'
  | 'const'
  | 'let'
  | 'var'
  | 'method'
  | 'unknown';

export interface ImportEntry {
  specifier: string;
  names: string[];
  line: number;
}

export interface DeclEntry {
  name: string;
  kind: DeclarationKind;
  line: number;
  exported: boolean;
}

export interface ExportEntry {
  name: string;
  kind?: DeclarationKind;
  source?: string;
  line: number;
}

export interface Outline {
  imports: ImportEntry[];
  exports: ExportEntry[];
  decls: DeclEntry[];
}

export interface LanguageProvider {
  language: string;
  extensions: string[];
  matches: (filePath: string) => boolean;
  declarationPatterns: (symbol: string) => string[];
  classifyMatch: (line: string, symbol: string) => { kind: DeclarationKind; exported: boolean };
  extractOutline?: (source: string) => Outline;
  resolveImport?: (specifier: string, fromPath: string, root: string) => Promise<string | null>;
  testPatterns?: (filePath: string) => { forSource: string[] };
}

export const TS_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts'];
export const JS_EXTENSIONS = ['.js', '.jsx', '.mjs', '.cjs'];
export const CODE_EXTENSIONS = [...TS_EXTENSIONS, ...JS_EXTENSIONS, '.json'];

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function normalizeRelativePath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\.\//, '');
}

export function isLocalSpecifier(specifier: string): boolean {
  return specifier.startsWith('./') || specifier.startsWith('../');
}

export async function fileExists(absolutePath: string): Promise<boolean> {
  return fs
    .stat(absolutePath)
    .then((stat) => stat.isFile())
    .catch(() => false);
}

function lineNumberAt(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (source[i] === '\n') line++;
  }
  return line;
}

function normalizeImportNames(rawNames: string): string[] {
  return rawNames
    .replace(/[{}]/g, '')
    .split(',')
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .map((part) => (part.startsWith('type ') ? part.slice(5).trim() : part))
    .filter(Boolean);
}

function* extractImportEntries(source: string): Generator<ImportEntry> {
  const sideEffect = /(?:^|[\n;])[ \t]*import\s+['"]([^'"]+)['"]/g;
  for (let m: RegExpExecArray | null; (m = sideEffect.exec(source)); ) {
    yield { specifier: m[1], names: [], line: lineNumberAt(source, m.index) };
  }

  // The names region excludes quotes/semicolons/parens so a match cannot cross statements.
  const fromImport = /\bimport\s+(?:type\s+)?([\w*${}\n\r\t ,]+?)\s+from\s*['"]([^'"]+)['"]/g;
  for (let m: RegExpExecArray | null; (m = fromImport.exec(source)); ) {
    yield { specifier: m[2], names: normalizeImportNames(m[1]), line: lineNumberAt(source, m.index) };
  }

  const requireImport = /\b(?:const|let|var)\s+([\w*${}\n\r\t ,]+?)\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (let m: RegExpExecArray | null; (m = requireImport.exec(source)); ) {
    yield { specifier: m[2], names: normalizeImportNames(m[1]), line: lineNumberAt(source, m.index) };
  }

  const dynamicImport = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (let m: RegExpExecArray | null; (m = dynamicImport.exec(source)); ) {
    yield { specifier: m[1], names: ['dynamic'], line: lineNumberAt(source, m.index) };
  }
}

function* extractReExportEntries(source: string): Generator<ExportEntry> {
  const reExport = /\bexport\s+(?:type\s+)?(\*(?:\s+as\s+[\w$]+)?|\{[\s\S]*?\})\s*from\s*['"]([^'"]+)['"]/g;
  for (let m: RegExpExecArray | null; (m = reExport.exec(source)); ) {
    const raw = m[1].trim();
    const name = raw.startsWith('{') ? raw.replace(/[{}]/g, '').trim() || '*' : raw;
    yield { source: m[2], name, line: lineNumberAt(source, m.index) };
  }
}

function parseTsJsDeclaration(line: string, lineNumber: number): DeclEntry | null {
  if (/^\s/.test(line)) return null;

  const match = line.match(
    /^(export\s+)?(?:default\s+)?(?:(async)\s+)?(function|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)\b/,
  );
  if (!match) return null;

  const kind = match[2] && match[3] === 'function' ? 'async function' : match[3];
  return {
    kind: kind as DeclarationKind,
    name: match[4],
    line: lineNumber,
    exported: Boolean(match[1]),
  };
}

function classifyTsJsMatch(line: string): { kind: DeclarationKind; exported: boolean } {
  const match = line.match(
    /^\s*(export\s+)?(?:default\s+)?(?:async\s+)?(?:abstract\s+)?(?:const\s+)?(function|class|interface|type|enum|const|let|var)\b/,
  );
  return {
    kind: (match?.[2] as DeclarationKind | undefined) ?? 'unknown',
    exported: Boolean(match?.[1]),
  };
}

function extractTsJsOutline(source: string): Outline {
  const imports = [...extractImportEntries(source)].sort((a, b) => a.line - b.line);
  const exports: ExportEntry[] = [...extractReExportEntries(source)];
  const decls: DeclEntry[] = [];
  const lines = source.split('\n');

  for (const [index, line] of lines.entries()) {
    const decl = parseTsJsDeclaration(line, index + 1);
    if (decl) {
      decls.push(decl);
      if (decl.exported) {
        exports.push({ name: decl.name, kind: decl.kind, line: decl.line });
      }
    }
  }

  exports.sort((a, b) => a.line - b.line);
  return { imports, exports, decls };
}

async function resolveLocalImport(specifier: string, fromPath: string, root: string): Promise<string | null> {
  if (!isLocalSpecifier(specifier)) return null;

  const fromDir = path.dirname(path.join(root, fromPath));
  const base = path.resolve(fromDir, specifier);
  // A `.js`/`.mjs`/`.jsx` specifier resolves to its `.ts`/`.mts`/`.tsx`
  // source under the TS ESM convention, so also try the extension-stripped form.
  const baseExtension = path.extname(base);
  const strippedBase = CODE_EXTENSIONS.includes(baseExtension) ? base.slice(0, -baseExtension.length) : base;
  const candidates = [
    base,
    ...CODE_EXTENSIONS.map((extension) => `${base}${extension}`),
    ...(strippedBase !== base ? CODE_EXTENSIONS.map((extension) => `${strippedBase}${extension}`) : []),
    ...CODE_EXTENSIONS.map((extension) => path.join(base, `index${extension}`)),
  ];

  for (const candidate of candidates) {
    const resolved = normalizeRelativePath(path.relative(root, candidate));
    if (!resolved.startsWith('..') && (await fileExists(candidate))) {
      return resolved;
    }
  }

  return null;
}

function buildTestPatterns(filePath: string): { forSource: string[] } {
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext).replace(/\.(test|spec)$/, '');
  const extensions = ['.ts', '.tsx', '.js', '.jsx'];
  const forSource = extensions.flatMap((extension) => [
    normalizeRelativePath(path.join(dir, `${base}.test${extension}`)),
    normalizeRelativePath(path.join(dir, `${base}.spec${extension}`)),
    normalizeRelativePath(path.join(dir, '__tests__', `${base}.test${extension}`)),
    normalizeRelativePath(path.join('tests', `${base}.test${extension}`)),
  ]);
  return { forSource };
}

const typescriptProvider: LanguageProvider = {
  language: 'typescript',
  extensions: TS_EXTENSIONS,
  matches: (filePath) => TS_EXTENSIONS.includes(path.extname(filePath)),
  declarationPatterns: (symbol) => [
    `^\\s*(export\\s+)?(default\\s+)?(async\\s+)?function\\s+${escapeRegExp(symbol)}\\b`,
    `^\\s*(export\\s+)?(default\\s+)?(abstract\\s+)?class\\s+${escapeRegExp(symbol)}\\b`,
    `^\\s*(export\\s+)?interface\\s+${escapeRegExp(symbol)}\\b`,
    `^\\s*(export\\s+)?type\\s+${escapeRegExp(symbol)}\\b`,
    `^\\s*(export\\s+)?(const\\s+)?enum\\s+${escapeRegExp(symbol)}\\b`,
    `^\\s*(export\\s+)?(const|let|var)\\s+${escapeRegExp(symbol)}\\b`,
  ],
  classifyMatch: classifyTsJsMatch,
  extractOutline: extractTsJsOutline,
  resolveImport: resolveLocalImport,
  testPatterns: buildTestPatterns,
};

const javascriptProvider: LanguageProvider = {
  ...typescriptProvider,
  language: 'javascript',
  extensions: JS_EXTENSIONS,
  matches: (filePath) => JS_EXTENSIONS.includes(path.extname(filePath)),
};

const pythonProvider: LanguageProvider = {
  language: 'python',
  extensions: ['.py'],
  matches: (filePath) => path.extname(filePath) === '.py',
  declarationPatterns: (symbol) => [
    `^\\s*def\\s+${escapeRegExp(symbol)}\\b`,
    `^\\s*class\\s+${escapeRegExp(symbol)}\\b`,
  ],
  classifyMatch: (line) => ({
    kind: /^\s*class\b/.test(line) ? 'class' : 'function',
    exported: false,
  }),
};

const goProvider: LanguageProvider = {
  language: 'go',
  extensions: ['.go'],
  matches: (filePath) => path.extname(filePath) === '.go',
  declarationPatterns: (symbol) => [
    `^\\s*func\\s+(\\([^)]*\\)\\s*)?${escapeRegExp(symbol)}\\b`,
    `^\\s*type\\s+${escapeRegExp(symbol)}\\b`,
  ],
  classifyMatch: (line, symbol) => ({
    kind: /^\s*func\b/.test(line) ? 'function' : 'type',
    exported: /^[A-Z]/.test(symbol),
  }),
};

const rustProvider: LanguageProvider = {
  language: 'rust',
  extensions: ['.rs'],
  matches: (filePath) => path.extname(filePath) === '.rs',
  declarationPatterns: (symbol) => [
    `^\\s*(pub\\s+)?fn\\s+${escapeRegExp(symbol)}\\b`,
    `^\\s*(pub\\s+)?struct\\s+${escapeRegExp(symbol)}\\b`,
    `^\\s*(pub\\s+)?enum\\s+${escapeRegExp(symbol)}\\b`,
    `^\\s*(pub\\s+)?trait\\s+${escapeRegExp(symbol)}\\b`,
  ],
  classifyMatch: (line) => {
    const kind: DeclarationKind = /^\s*(pub\s+)?fn\b/.test(line)
      ? 'function'
      : /^\s*(pub\s+)?enum\b/.test(line)
      ? 'enum'
      : /^\s*(pub\\s+)?trait\b/.test(line)
      ? 'interface'
      : 'type';
    return { kind, exported: /^\s*pub\s+/.test(line) };
  },
};

const jsonProvider: LanguageProvider = {
  language: 'json',
  extensions: ['.json'],
  matches: (filePath) => path.extname(filePath) === '.json',
  declarationPatterns: (symbol) => [`"${escapeRegExp(symbol)}"\\s*:`],
  classifyMatch: () => ({ kind: 'unknown' as DeclarationKind, exported: false }),
  extractOutline: (source: string): Outline => {
    try {
      const parsed = JSON.parse(source);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return { imports: [], exports: [], decls: [] };
      }
      const decls: DeclEntry[] = Object.keys(parsed).map((key, index) => ({
        name: key,
        kind: 'unknown' as DeclarationKind,
        line: index + 1,
        exported: false,
      }));
      return { imports: [], exports: [], decls };
    } catch {
      return { imports: [], exports: [], decls: [] };
    }
  },
};

export const providers = [
  typescriptProvider,
  javascriptProvider,
  pythonProvider,
  goProvider,
  rustProvider,
  jsonProvider,
];

export function getProvider(filePath: string): LanguageProvider | null {
  return providers.find((provider) => provider.matches(filePath)) ?? null;
}
