import path from 'path';
import { LanguageProvider, Outline, DeclarationKind, DeclEntry, ExportEntry, ImportEntry } from './types.js';
import {
  escapeRegExp,
  lineNumberAt,
  normalizeImportNames,
  resolveLocalImport,
  buildTestPatterns,
  TS_EXTENSIONS,
  JS_EXTENSIONS,
} from './utils.js';

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
    /^\s*(export\s+)?(?:default\s+)?(?:(async)\s+)?(?:abstract\s+)?(?:const\s+)?(function|class|interface|type|enum|const|let|var)\b/,
  );
  const rawKind = (match?.[3] as DeclarationKind | undefined) ?? 'unknown';
  const isAsync = Boolean(match?.[2]);
  const kind = isAsync && rawKind === 'function' ? 'async function' : rawKind;
  return {
    kind,
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

export const typescriptProvider: LanguageProvider = {
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

export const javascriptProvider: LanguageProvider = {
  ...typescriptProvider,
  language: 'javascript',
  extensions: JS_EXTENSIONS,
  matches: (filePath) => JS_EXTENSIONS.includes(path.extname(filePath)),
};
