import path from 'path';
import { LanguageProvider, Outline, ImportEntry, ExportEntry, DeclEntry } from './types.js';
import { escapeRegExp, normalizeRelativePath, lineNumberAt, fileExists } from './utils.js';

const cppKeywords = new Set([
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'return',
  'throw',
  'using',
  'template',
  'sizeof',
  'decltype',
  'static_cast',
  'dynamic_cast',
  'reinterpret_cast',
  'const_cast',
  'alignas',
  'alignof',
  'noexcept',
  'operator',
  'delete',
  'new',
  'typedef',
  'friend',
  'explicit',
  'inline',
  'virtual',
  'const',
  'constexpr',
  'volatile',
  'mutable',
  'thread_local',
  'static',
  'register',
  'extern',
  'auto',
  'union',
  'namespace',
  'class',
  'struct',
  'enum',
  'default',
  'public',
  'private',
  'protected',
]);

function stripComments(source: string): string {
  let result = '';
  let i = 0;
  while (i < source.length) {
    if (source[i] === '/' && source[i + 1] === '/') {
      result += '//';
      i += 2;
      while (i < source.length && source[i] !== '\n') {
        result += ' ';
        i++;
      }
    } else if (source[i] === '/' && source[i + 1] === '*') {
      result += '  ';
      i += 2;
      while (i < source.length) {
        if (source[i] === '*' && source[i + 1] === '/') {
          result += '  ';
          i += 2;
          break;
        }
        result += source[i] === '\n' ? '\n' : ' ';
        i++;
      }
    } else {
      result += source[i];
      i++;
    }
  }
  return result;
}

function findMatchingBrace(source: string, openIndex: number): number {
  let depth = 1;
  let i = openIndex + 1;
  while (i < source.length) {
    if (source[i] === '{') {
      depth++;
    } else if (source[i] === '}') {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
    i++;
  }
  return source.length;
}

export function extractCppOutline(source: string): Outline {
  const stripped = stripComments(source);
  const imports: ImportEntry[] = [];
  const decls: DeclEntry[] = [];
  const exports: ExportEntry[] = [];

  // 1. Extract includes
  const includeRegex = /^[ \t]*#[ \t]*include\s+(?:<([^>]+)>|"([^"]+)")/gm;
  let m;
  while ((m = includeRegex.exec(stripped)) !== null) {
    let specifier = m[1] ? `<${m[1]}>` : m[2];
    if (m[2] && !m[2].startsWith('./') && !m[2].startsWith('../')) {
      specifier = `./${m[2]}`;
    }
    const line = lineNumberAt(source, m.index);
    imports.push({ specifier, names: [], line });
  }

  // 2. Extract declarations
  interface RawCandidate {
    index: number;
    type: 'class' | 'struct' | 'union' | 'enum' | 'namespace' | 'function';
    name: string;
    hasBody: boolean;
    braceOrSemicolonIndex: number;
  }
  const candidates: RawCandidate[] = [];

  // Match class/struct/union
  const classRegex = /\b(class|struct|union)\s+([A-Za-z_]\w*)(?:\s*:[^{;]*)?\s*(\{)/g;
  while ((m = classRegex.exec(stripped)) !== null) {
    candidates.push({
      index: m.index,
      type: m[1] as any,
      name: m[2],
      hasBody: true,
      braceOrSemicolonIndex: classRegex.lastIndex - 1,
    });
  }

  // Match enum
  const enumRegex = /\benum\s+(?:class\s+)?([A-Za-z_]\w*)\s*(?::[^{;]*)?\s*(\{)/g;
  while ((m = enumRegex.exec(stripped)) !== null) {
    candidates.push({
      index: m.index,
      type: 'enum',
      name: m[1],
      hasBody: true,
      braceOrSemicolonIndex: enumRegex.lastIndex - 1,
    });
  }

  // Match namespace (including C++17 nested: namespace foo::bar)
  const namespaceRegex = /\bnamespace\s+([A-Za-z_]\w*(?:::[A-Za-z_]\w*)*)?\s*(\{)/g;
  while ((m = namespaceRegex.exec(stripped)) !== null) {
    candidates.push({
      index: m.index,
      type: 'namespace',
      name: m[1] || 'anonymous',
      hasBody: true,
      braceOrSemicolonIndex: namespaceRegex.lastIndex - 1,
    });
  }

  // Match functions and methods — allow nested parens in parameter types (e.g. std::function<void(int)>)
  const funcRegex = /\b([A-Za-z_]\w*::)*(~?[A-Za-z_]\w*)\s*\([^{;]*\)[^{;]*([{;])/g;
  while ((m = funcRegex.exec(stripped)) !== null) {
    const name = (m[1] || '') + m[2];
    const nameBase = m[2];
    if (cppKeywords.has(nameBase) || cppKeywords.has(m[1]?.slice(0, -2) ?? '')) {
      continue;
    }
    candidates.push({
      index: m.index,
      type: 'function',
      name,
      hasBody: m[3] === '{',
      braceOrSemicolonIndex: funcRegex.lastIndex - 1,
    });
  }

  candidates.sort((a, b) => a.index - b.index);

  const activeScopes: { type: string; name: string; closeBraceIndex: number }[] = [];
  let skipUntilIndex = -1;

  for (const candidate of candidates) {
    if (candidate.index < skipUntilIndex) {
      continue;
    }

    while (activeScopes.length > 0 && activeScopes[activeScopes.length - 1].closeBraceIndex <= candidate.index) {
      activeScopes.pop();
    }

    const line = lineNumberAt(source, candidate.index);

    if (candidate.type === 'namespace') {
      const closeBraceIndex = findMatchingBrace(stripped, candidate.braceOrSemicolonIndex);
      activeScopes.push({
        type: 'namespace',
        name: candidate.name,
        closeBraceIndex,
      });
      continue;
    }

    if (candidate.type === 'class' || candidate.type === 'struct' || candidate.type === 'union') {
      const closeBraceIndex = findMatchingBrace(stripped, candidate.braceOrSemicolonIndex);
      activeScopes.push({
        type: candidate.type,
        name: candidate.name,
        closeBraceIndex,
      });

      decls.push({
        name: candidate.name,
        kind: 'class',
        line,
        exported: true,
      });
      exports.push({
        name: candidate.name,
        kind: 'class',
        line,
      });
      continue;
    }

    if (candidate.type === 'enum') {
      const closeBraceIndex = findMatchingBrace(stripped, candidate.braceOrSemicolonIndex);
      activeScopes.push({
        type: 'enum',
        name: candidate.name,
        closeBraceIndex,
      });

      decls.push({
        name: candidate.name,
        kind: 'enum',
        line,
        exported: true,
      });
      exports.push({
        name: candidate.name,
        kind: 'enum',
        line,
      });
      continue;
    }

    if (candidate.type === 'function') {
      const hasClassInScope = activeScopes.some((s) => s.type === 'class' || s.type === 'struct' || s.type === 'union');
      const isMethod = candidate.name.includes('::') || hasClassInScope;
      const kind = isMethod ? 'method' : 'function';

      decls.push({
        name: candidate.name,
        kind,
        line,
        exported: true,
      });
      exports.push({
        name: candidate.name,
        kind,
        line,
      });

      if (candidate.hasBody) {
        const closeBraceIndex = findMatchingBrace(stripped, candidate.braceOrSemicolonIndex);
        skipUntilIndex = closeBraceIndex;
      }
    }
  }

  imports.sort((a, b) => a.line - b.line);
  exports.sort((a, b) => a.line - b.line);
  decls.sort((a, b) => a.line - b.line);

  return { imports, exports, decls };
}

export async function resolveLocalCppImport(specifier: string, fromPath: string, root: string): Promise<string | null> {
  if (specifier.startsWith('<')) return null;
  const cleanSpecifier = specifier.replace(/^"|"$/g, '');
  const fromDir = path.dirname(path.join(root, fromPath));
  const candidate = path.resolve(fromDir, cleanSpecifier);

  const resolved = normalizeRelativePath(path.relative(root, candidate));
  if (!resolved.startsWith('..') && (await fileExists(candidate))) {
    return resolved;
  }
  return null;
}

export function buildCppTestPatterns(filePath: string): { forSource: string[] } {
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  const extensions = ['.cpp', '.cc', '.cxx', '.c'];
  const forSource = extensions.flatMap((extension) => [
    normalizeRelativePath(path.join(dir, `${base}_test${extension}`)),
    normalizeRelativePath(path.join(dir, `test_${base}${extension}`)),
    normalizeRelativePath(path.join(dir, 'tests', `${base}_test${extension}`)),
    normalizeRelativePath(path.join('tests', `${base}_test${extension}`)),
  ]);
  return { forSource };
}

export const cppProvider: LanguageProvider = {
  language: 'cpp',
  extensions: ['.c', '.cpp', '.cc', '.cxx', '.h', '.hpp', '.hxx'],
  matches: (filePath) => {
    const ext = path.extname(filePath).toLowerCase();
    return ['.c', '.cpp', '.cc', '.cxx', '.h', '.hpp', '.hxx'].includes(ext);
  },
  declarationPatterns: (symbol) => [
    `\\b(class|struct|enum(\\s+class)?)\\s+${escapeRegExp(symbol)}\\b`,
    `\\b[A-Za-z_]\\w*::~?${escapeRegExp(symbol)}\\s*\\(`,
    `^\\s*([\\w:*&<>~]+\\s+)+~?${escapeRegExp(symbol)}\\s*\\(`,
    `^\\s*~?${escapeRegExp(symbol)}\\s*\\(`,
  ],
  classifyMatch: (line, symbol) => {
    const isEnum = new RegExp(`\\benum\\b.*\\b${escapeRegExp(symbol)}\\b`).test(line);
    const isClass = !isEnum && new RegExp(`\\b(class|struct)\\s+${escapeRegExp(symbol)}\\b`).test(line);
    if (isClass) return { kind: 'class', exported: true };
    if (isEnum) return { kind: 'enum', exported: true };

    const isFunc = new RegExp(`\\b~?${escapeRegExp(symbol)}\\s*\\(`).test(line);
    if (isFunc) {
      const isMethod = line.includes('::');
      return { kind: isMethod ? 'method' : 'function', exported: true };
    }
    return { kind: 'unknown', exported: true };
  },
  extractOutline: extractCppOutline,
  resolveImport: resolveLocalCppImport,
  testPatterns: buildCppTestPatterns,
};
