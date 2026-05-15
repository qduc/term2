import { z } from 'zod';
import * as fs from 'fs/promises';
import path from 'path';
import { execFile } from 'child_process';
import util from 'util';
import { resolveWorkspacePath, relaxedNumber } from './utils.js';
import type { CommandMessage, ToolDefinition } from './types.js';
import { createBaseMessage, getCallIdFromItem, getOutputText, normalizeToolArguments } from './format-helpers.js';
import { ExecutionContext } from '../services/execution-context.js';

const execFilePromise = util.promisify(execFile);

type DeclarationKind =
  | 'function'
  | 'class'
  | 'interface'
  | 'type'
  | 'enum'
  | 'const'
  | 'let'
  | 'var'
  | 'method'
  | 'unknown';
type RelationToken =
  | 'imports_target'
  | 'imported_by_target'
  | 'barrel_export'
  | 'likely_test'
  | 'likely_source_for_test'
  | 'same_directory'
  | 'package_entry'
  | 'config_reference';

interface ImportEntry {
  specifier: string;
  names: string[];
  line: number;
}

interface DeclEntry {
  name: string;
  kind: DeclarationKind;
  line: number;
  exported: boolean;
}

interface ExportEntry {
  name: string;
  kind?: DeclarationKind;
  source?: string;
  line: number;
}

interface Outline {
  imports: ImportEntry[];
  exports: ExportEntry[];
  decls: DeclEntry[];
}

interface SymbolMatch extends DeclEntry {
  filePath: string;
}

interface LanguageProvider {
  language: string;
  extensions: string[];
  matches: (filePath: string) => boolean;
  declarationPatterns: (symbol: string) => string[];
  classifyMatch: (line: string, symbol: string) => { kind: DeclarationKind; exported: boolean };
  extractOutline?: (source: string) => Outline;
  resolveImport?: (specifier: string, fromPath: string, root: string) => Promise<string | null>;
  testPatterns?: (filePath: string) => { forSource: string[] };
}

const readCodeOutlineParametersSchema = z.object({
  path: z.string().describe('File path relative to workspace root'),
});

const codeContextSearchParametersSchema = z
  .object({
    query_type: z.enum(['related', 'symbol']).describe('Search mode: related files by path or declarations by symbol.'),
    path: z.string().optional().describe('Target file path. Required when query_type is related.'),
    symbol: z.string().optional().describe('Identifier to search for. Required when query_type is symbol.'),
    max_results: relaxedNumber.int().positive().optional().describe('Maximum number of results. Defaults to 20.'),
  })
  .superRefine((value, context) => {
    if (value.query_type === 'related' && !value.path) {
      context.addIssue({
        code: 'custom',
        path: ['path'],
        message: 'path is required when query_type is related',
      });
    }

    if (value.query_type === 'symbol' && !value.symbol) {
      context.addIssue({
        code: 'custom',
        path: ['symbol'],
        message: 'symbol is required when query_type is symbol',
      });
    }
  });

export type ReadCodeOutlineToolParams = z.infer<typeof readCodeOutlineParametersSchema>;
export type CodeContextSearchToolParams = z.infer<typeof codeContextSearchParametersSchema>;

const TS_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts'];
const JS_EXTENSIONS = ['.js', '.jsx', '.mjs', '.cjs'];
const CODE_EXTENSIONS = [...TS_EXTENSIONS, ...JS_EXTENSIONS, '.json'];
const IMPORTER_EXTENSIONS = [...TS_EXTENSIONS, ...JS_EXTENSIONS];
const SKIP_DIRS = ['.git', 'node_modules', 'dist', 'build', 'coverage', '.next', '.nuxt', '.cache', 'out', 'vendor'];
const MAX_TARGET_BYTES = 512 * 1024;
const MAX_FILES_SEARCHED = 10_000;
const DEFAULT_MAX_RESULTS = 20;
const RELATED_RANK: RelationToken[] = [
  'likely_test',
  'likely_source_for_test',
  'imports_target',
  'imported_by_target',
  'barrel_export',
  'package_entry',
  'config_reference',
  'same_directory',
];
const RELATION_DISPLAY_ORDER: RelationToken[] = [
  'likely_test',
  'likely_source_for_test',
  'imports_target',
  'barrel_export',
  'imported_by_target',
  'package_entry',
  'config_reference',
  'same_directory',
];

export const createReadCodeOutlineToolDefinition = (
  deps: { executionContext?: ExecutionContext } = {},
): ToolDefinition<ReadCodeOutlineToolParams> => {
  const { executionContext } = deps;
  return {
    name: 'read_code_outline',
    description:
      'Compact outline of one file: imports, exports, declarations. No bodies. Use `read_file` before editing.',
    parameters: readCodeOutlineParametersSchema,
    needsApproval: () => false,
    execute: async ({ path: filePath }) => {
      const cwd = executionContext?.getCwd() || process.cwd();

      try {
        const absolutePath = resolveWorkspacePath(filePath, cwd);
        const stat = await fs.stat(absolutePath);
        if (stat.size > MAX_TARGET_BYTES) {
          return `WARNING target_too_large\n${formatEmptyOutline(filePath, 'unknown')}`;
        }

        const source = await fs.readFile(absolutePath, 'utf8');
        const provider = getProvider(filePath);
        if (!provider?.extractOutline) {
          return formatEmptyOutline(filePath, provider?.language ?? 'unknown');
        }

        return formatOutline(filePath, provider.language, provider.extractOutline(source));
      } catch (error: any) {
        return formatFileError(error, filePath);
      }
    },
    formatCommandMessage: formatReadCodeOutlineCommandMessage,
  };
};

export const createCodeContextSearchToolDefinition = (
  deps: { executionContext?: ExecutionContext } = {},
): ToolDefinition<CodeContextSearchToolParams> => {
  const { executionContext } = deps;
  return {
    name: 'code_context_search',
    description:
      'Bounded just-in-time search for related files (by path) or symbol declarations (by name). Plain text, fixed relation tokens. Use `read_file` before editing.',
    parameters: codeContextSearchParametersSchema,
    needsApproval: () => false,
    execute: async (params) => {
      const cwd = executionContext?.getCwd() || process.cwd();
      const maxResults = params.max_results ?? DEFAULT_MAX_RESULTS;

      try {
        if (!(await isRipgrepAvailable())) {
          return params.query_type === 'related'
            ? `WARNING rg_unavailable\n${formatRelatedResults(params.path ?? '', [])}`
            : `WARNING rg_unavailable\n${formatSymbolResults(params.symbol ?? '', [])}`;
        }

        if (params.query_type === 'related') {
          const targetPath = params.path!;
          const absolutePath = resolveWorkspacePath(targetPath, cwd);
          await assertReadableTarget(absolutePath);
          const provider = getProvider(targetPath);
          if (!provider?.extractOutline) {
            return `WARNING unsupported_language\n${formatRelatedResults(targetPath, [])}`;
          }
          const { results, truncated, partial } = await findRelatedFiles({
            root: cwd,
            targetPath,
            absolutePath,
            maxResults,
          });
          return withWarnings(
            formatRelatedResults(targetPath, results),
            partial ? ['partial_search'] : [],
            truncated ? ['result_limit_reached'] : [],
          );
        }

        const symbol = params.symbol!;
        if (!isSafeIdentifier(symbol)) {
          return 'Error: symbol must be an identifier-safe name.';
        }

        const { matches, truncated, partial } = await findSymbolDeclarations({ root: cwd, symbol, maxResults });
        return withWarnings(
          formatSymbolResults(symbol, matches),
          partial ? ['partial_search'] : [],
          truncated ? ['result_limit_reached'] : [],
        );
      } catch (error: any) {
        return formatSearchError(error);
      }
    },
    formatCommandMessage: formatCodeContextSearchCommandMessage,
  };
};

export const formatReadCodeOutlineCommandMessage = (
  item: any,
  index: number,
  toolCallArgumentsById: Map<string, unknown>,
): CommandMessage[] => {
  const args = getFormatterArgs(item, toolCallArgumentsById);
  const filePath = args?.path ?? 'unknown';
  const output = getOutputText(item) || 'No output';

  return [
    createBaseMessage(item, index, 0, false, {
      command: `read_code_outline "${filePath}"`,
      output,
      success: !output.startsWith('Error:'),
      toolName: 'read_code_outline',
      toolArgs: args,
    }),
  ];
};

export const formatCodeContextSearchCommandMessage = (
  item: any,
  index: number,
  toolCallArgumentsById: Map<string, unknown>,
): CommandMessage[] => {
  const args = getFormatterArgs(item, toolCallArgumentsById);
  const output = getOutputText(item) || 'No output';
  const command =
    args?.query_type === 'symbol'
      ? `code_context_search symbol "${args?.symbol ?? 'unknown'}"`
      : `code_context_search related "${args?.path ?? 'unknown'}"`;

  return [
    createBaseMessage(item, index, 0, false, {
      command,
      output,
      success: !output.startsWith('Error:'),
      toolName: 'code_context_search',
      toolArgs: args,
    }),
  ];
};

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
      : /^\s*(pub\s+)?trait\b/.test(line)
      ? 'interface'
      : 'type';
    return { kind, exported: /^\s*pub\s+/.test(line) };
  },
};

const providers = [typescriptProvider, javascriptProvider, pythonProvider, goProvider, rustProvider];

function getFormatterArgs(item: any, toolCallArgumentsById: Map<string, unknown>): any {
  const callId = getCallIdFromItem(item);
  const fallbackArgs = callId && toolCallArgumentsById.has(callId) ? toolCallArgumentsById.get(callId) : null;
  const normalizedArgs = item?.rawItem?.arguments ?? item?.arguments;
  return normalizeToolArguments(normalizedArgs) ?? normalizeToolArguments(fallbackArgs) ?? {};
}

function getProvider(filePath: string): LanguageProvider | null {
  return providers.find((provider) => provider.matches(filePath)) ?? null;
}

function formatOutline(filePath: string, language: string, outline: Outline): string {
  return [
    `FILE ${normalizeRelativePath(filePath)}`,
    `LANG ${language}`,
    '',
    'IMPORTS',
    formatImports(outline.imports),
    '',
    'EXPORTS',
    formatExports(outline.exports),
    '',
    'DECLARATIONS',
    formatDeclarations(outline.decls),
  ].join('\n');
}

function formatEmptyOutline(filePath: string, language: string): string {
  return formatOutline(filePath, language, { imports: [], exports: [], decls: [] });
}

function formatImports(imports: ImportEntry[]): string {
  if (imports.length === 0) return 'EMPTY';
  return imports
    .map((entry) => `${entry.specifier}: ${entry.names.join(' ') || 'side-effect'} line=${entry.line}`)
    .join('\n');
}

function formatExports(exports: ExportEntry[]): string {
  if (exports.length === 0) return 'EMPTY';
  return exports
    .map((entry) => {
      if (entry.source) {
        return `${entry.source}: ${entry.name} line=${entry.line}`;
      }
      return `export ${entry.kind ?? 'unknown'} ${entry.name} line=${entry.line}`;
    })
    .join('\n');
}

function formatDeclarations(decls: DeclEntry[]): string {
  if (decls.length === 0) return 'EMPTY';
  return decls
    .map((decl) => `${decl.kind} ${decl.name} line=${decl.line}${decl.exported ? ' exported' : ''}`)
    .join('\n');
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

function lineNumberAt(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (source[i] === '\n') line++;
  }
  return line;
}

// Whole-source scan so multi-line named imports are captured correctly.
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

function normalizeImportNames(rawNames: string): string[] {
  return rawNames
    .replace(/[{}]/g, '')
    .split(',')
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function parseTsJsDeclaration(line: string, lineNumber: number): DeclEntry | null {
  if (/^\s/.test(line)) return null;

  const match = line.match(
    /^(export\s+)?(?:default\s+)?(?:(async)\s+)?(function|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)\b/,
  );
  if (!match) return null;

  return {
    kind: match[3] as DeclarationKind,
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

async function assertReadableTarget(absolutePath: string): Promise<void> {
  const stat = await fs.stat(absolutePath);
  if (stat.size > MAX_TARGET_BYTES) {
    throw new Error('target_too_large');
  }
}

async function findRelatedFiles(options: {
  root: string;
  targetPath: string;
  absolutePath: string;
  maxResults: number;
}): Promise<{ results: Array<{ filePath: string; tokens: RelationToken[] }>; truncated: boolean; partial: boolean }> {
  const targetPath = normalizeRelativePath(path.relative(options.root, options.absolutePath));
  const targetProvider = getProvider(targetPath);
  const relations = new Map<string, Set<RelationToken>>();

  if (!targetProvider?.extractOutline) {
    return { results: [], truncated: false, partial: false };
  }

  const targetSource = await fs.readFile(options.absolutePath, 'utf8');
  const targetOutline = targetProvider.extractOutline(targetSource);
  const targetIsTest = isTestFile(targetPath);

  for (const importEntry of targetOutline.imports.filter((entry) => isLocalSpecifier(entry.specifier))) {
    const resolved = await targetProvider.resolveImport?.(importEntry.specifier, targetPath, options.root);
    if (resolved) {
      addRelation(relations, resolved, 'imports_target');
      if (targetIsTest) {
        addRelation(relations, resolved, 'likely_source_for_test');
      }
    }
  }

  for (const patternPath of targetProvider.testPatterns?.(targetPath).forSource ?? []) {
    if (await fileExists(path.join(options.root, patternPath))) {
      addRelation(relations, patternPath, 'likely_test');
    }
  }

  // ripgrep narrows the candidate set; per-file import resolution confirms the
  // relation so a same-named sibling module cannot produce a false positive.
  const searchToken =
    path.basename(targetPath, path.extname(targetPath)) === 'index'
      ? path.basename(path.dirname(targetPath))
      : path.basename(targetPath, path.extname(targetPath));
  const candidatePattern = `(from|require\\(|import\\()[ \\t]*['"][^'"]*${escapeRegExp(searchToken)}`;
  const { stdout: candidateOut, ok } = await runRipgrep(
    [
      '-l',
      '--max-filesize',
      String(MAX_TARGET_BYTES),
      ...skipGlobArgs(),
      ...IMPORTER_EXTENSIONS.flatMap((ext) => ['-g', `*${ext}`]),
      '-e',
      candidatePattern,
      '.',
    ],
    options.root,
  );

  const candidates = ok
    ? candidateOut
        .split('\n')
        .map((entry) => normalizeRelativePath(entry.trim()))
        .filter((entry) => entry && entry !== targetPath)
    : [];
  const partial = candidates.length > MAX_FILES_SEARCHED;

  for (const candidate of candidates.slice(0, MAX_FILES_SEARCHED)) {
    const candidateProvider = getProvider(candidate);
    if (!candidateProvider?.extractOutline) continue;

    const source = await readSmallTextFile(path.join(options.root, candidate));
    if (source === null) continue;

    const outline = candidateProvider.extractOutline(source);
    let importsTarget = false;
    let reExportsTarget = false;

    for (const entry of outline.imports.filter((item) => isLocalSpecifier(item.specifier))) {
      const resolved = await candidateProvider.resolveImport?.(entry.specifier, candidate, options.root);
      if (resolved === targetPath) importsTarget = true;
    }
    for (const entry of outline.exports.filter((item) => item.source && isLocalSpecifier(item.source))) {
      const resolved = await candidateProvider.resolveImport?.(entry.source!, candidate, options.root);
      if (resolved === targetPath) reExportsTarget = true;
    }

    if (importsTarget || reExportsTarget) {
      addRelation(relations, candidate, 'imported_by_target');
      if (reExportsTarget && isBarrelExportOnly(source)) {
        addRelation(relations, candidate, 'barrel_export');
      }
    }
  }

  for (const sibling of await listSameDirectoryFiles(options.root, targetPath)) {
    addRelation(relations, sibling, 'same_directory');
  }

  const ranked = [...relations.entries()]
    .map(([filePath, tokens]) => ({ filePath, tokens: [...tokens].sort(sortRelationTokens) }))
    .sort((a, b) => {
      const rank = rankRelation(a.tokens) - rankRelation(b.tokens);
      return rank === 0 ? a.filePath.localeCompare(b.filePath) : rank;
    });

  return {
    results: ranked.slice(0, options.maxResults),
    truncated: ranked.length > options.maxResults,
    partial,
  };
}

async function findSymbolDeclarations(options: {
  root: string;
  symbol: string;
  maxResults: number;
}): Promise<{ matches: SymbolMatch[]; truncated: boolean; partial: boolean }> {
  const byFile = new Map<string, SymbolMatch>();
  let partial = false;

  for (const provider of providers) {
    const patterns = provider.declarationPatterns(options.symbol);
    const { stdout, ok } = await runRipgrep(
      [
        '--no-heading',
        '--line-number',
        '--color=never',
        '--max-filesize',
        String(MAX_TARGET_BYTES),
        ...skipGlobArgs(),
        ...provider.extensions.flatMap((ext) => ['-g', `*${ext}`]),
        ...patterns.flatMap((pattern) => ['-e', pattern]),
        '.',
      ],
      options.root,
    );
    if (!ok) continue;

    const lines = stdout.split('\n').filter(Boolean);
    if (lines.length > MAX_FILES_SEARCHED) partial = true;

    for (const rawLine of lines.slice(0, MAX_FILES_SEARCHED)) {
      const parsed = parseRipgrepLine(rawLine);
      if (!parsed) continue;
      if (byFile.has(parsed.filePath)) continue;

      const classified = provider.classifyMatch(parsed.content, options.symbol);
      byFile.set(parsed.filePath, {
        filePath: parsed.filePath,
        name: options.symbol,
        kind: classified.kind,
        line: parsed.line,
        exported: classified.exported,
      });
    }
  }

  const sorted = [...byFile.values()].sort(
    (a, b) =>
      rankSymbolMatch(a, options.symbol) - rankSymbolMatch(b, options.symbol) || a.filePath.localeCompare(b.filePath),
  );

  return {
    matches: sorted.slice(0, options.maxResults),
    truncated: sorted.length > options.maxResults,
    partial,
  };
}

function parseRipgrepLine(rawLine: string): { filePath: string; line: number; content: string } | null {
  const match = rawLine.match(/^(.*?):(\d+):(.*)$/);
  if (!match) return null;
  return {
    filePath: normalizeRelativePath(match[1]),
    line: Number(match[2]),
    content: match[3],
  };
}

function withWarnings(body: string, ...warningGroups: string[][]): string {
  const warnings = warningGroups.flat();
  if (warnings.length === 0) return body;
  return `${warnings.map((code) => `WARNING ${code}`).join('\n')}\n${body}`;
}

function formatRelatedResults(
  targetPath: string,
  results: Array<{ filePath: string; tokens: RelationToken[] }>,
): string {
  const header = [`QUERY related`, `TARGET ${normalizeRelativePath(targetPath)}`].join('\n');
  if (results.length === 0) {
    return `${header}\n\nNO_RESULTS`;
  }

  return `${header}\n\n${results.map((result) => `${result.filePath}\nREL ${result.tokens.join(' ')}`).join('\n\n')}`;
}

function formatSymbolResults(symbol: string, results: SymbolMatch[]): string {
  const header = [`QUERY symbol`, `SYMBOL ${symbol}`].join('\n');
  if (results.length === 0) {
    return `${header}\n\nNO_RESULTS`;
  }

  return `${header}\n\n${results
    .map((match) => `${match.filePath}:${match.line} ${match.kind} ${match.name}${match.exported ? ' exported' : ''}`)
    .join('\n')}`;
}

let ripgrepAvailable: boolean | null = null;

async function isRipgrepAvailable(): Promise<boolean> {
  if (ripgrepAvailable !== null) return ripgrepAvailable;
  try {
    await execFilePromise('rg', ['--version']);
    ripgrepAvailable = true;
  } catch {
    ripgrepAvailable = false;
  }
  return ripgrepAvailable;
}

function skipGlobArgs(): string[] {
  return SKIP_DIRS.flatMap((dir) => ['-g', `!**/${dir}/**`]);
}

async function runRipgrep(args: string[], cwd: string): Promise<{ stdout: string; ok: boolean }> {
  try {
    const { stdout } = await execFilePromise('rg', args, {
      cwd,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { stdout, ok: true };
  } catch (error: any) {
    // rg exits 1 when there are no matches; that is a successful empty result.
    if (error && error.code === 1) {
      return { stdout: '', ok: true };
    }
    return { stdout: '', ok: false };
  }
}

async function listSameDirectoryFiles(root: string, targetPath: string): Promise<string[]> {
  const dir = path.dirname(targetPath);
  const absoluteDir = path.join(root, dir);
  const entries = await fs.readdir(absoluteDir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => normalizeRelativePath(path.join(dir, entry.name)))
    .filter(
      (filePath) =>
        filePath !== targetPath && [...CODE_EXTENSIONS, '.py', '.go', '.rs'].includes(path.extname(filePath)),
    )
    .sort()
    .slice(0, 5);
}

async function readSmallTextFile(absolutePath: string): Promise<string | null> {
  if (await isBinaryOrOversized(absolutePath)) return null;
  return fs.readFile(absolutePath, 'utf8').catch(() => null);
}

async function isBinaryOrOversized(absolutePath: string): Promise<boolean> {
  const stat = await fs.stat(absolutePath).catch(() => null);
  if (!stat || stat.size > MAX_TARGET_BYTES) return true;
  const handle = await fs.open(absolutePath, 'r').catch(() => null);
  if (!handle) return true;

  try {
    const buffer = Buffer.alloc(Math.min(512, stat.size));
    await handle.read(buffer, 0, buffer.length, 0);
    return buffer.includes(0);
  } finally {
    await handle.close();
  }
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

function isBarrelExportOnly(source: string): boolean {
  const meaningfulLines = source
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('//'));
  return (
    meaningfulLines.length > 0 &&
    meaningfulLines.every((line) => /^export\s+(?:\*|\{[^}]*\})\s+from\s+['"][^'"]+['"];?$/.test(line))
  );
}

function isLocalSpecifier(specifier: string): boolean {
  return specifier.startsWith('./') || specifier.startsWith('../');
}

function isTestFile(filePath: string): boolean {
  return /\.(test|spec)\.[^.]+$/.test(filePath) || filePath.includes('/__tests__/') || filePath.startsWith('tests/');
}

function addRelation(relations: Map<string, Set<RelationToken>>, filePath: string, token: RelationToken): void {
  const normalized = normalizeRelativePath(filePath);
  const current = relations.get(normalized) ?? new Set<RelationToken>();
  current.add(token);
  relations.set(normalized, current);
}

function sortRelationTokens(a: RelationToken, b: RelationToken): number {
  return RELATION_DISPLAY_ORDER.indexOf(a) - RELATION_DISPLAY_ORDER.indexOf(b);
}

function rankRelation(tokens: RelationToken[]): number {
  return Math.min(...tokens.map((token) => RELATED_RANK.indexOf(token)));
}

function rankSymbolMatch(match: SymbolMatch, symbol: string): number {
  const exact = match.name === symbol;
  if (exact && match.exported) return 0;
  if (exact) return 1;
  return 5;
}

function isSafeIdentifier(symbol: string): boolean {
  return /^[A-Za-z_$][\w$]*$/.test(symbol);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeRelativePath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\.\//, '');
}

async function fileExists(absolutePath: string): Promise<boolean> {
  return fs
    .stat(absolutePath)
    .then((stat) => stat.isFile())
    .catch(() => false);
}

function formatFileError(error: any, filePath: string): string {
  if (error.message?.includes('outside workspace')) {
    return `Error: ${error.message}`;
  }
  if (error.code === 'ENOENT') {
    return `Error: File not found: ${filePath}`;
  }
  if (error.code === 'EACCES') {
    return `Error: Permission denied: ${filePath}`;
  }
  if (error.code === 'EISDIR') {
    return `Error: Path is a directory: ${filePath}`;
  }
  return `Error: ${error.message || String(error)}`;
}

function formatSearchError(error: any): string {
  if (error.message?.includes('outside workspace')) {
    return `Error: ${error.message}`;
  }
  if (error.message === 'target_too_large') {
    return 'WARNING target_too_large\nNO_RESULTS';
  }
  if (error.code === 'ENOENT') {
    return 'Error: File not found';
  }
  return `Error: ${error.message || String(error)}`;
}
