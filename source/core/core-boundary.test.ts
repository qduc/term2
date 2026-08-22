import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { basename, dirname, extname, join, normalize, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { it, expect } from 'vitest';

const coreEntry = resolve(dirname(fileURLToPath(import.meta.url)), 'index.ts');
const sourceRoot = resolve(dirname(coreEntry), '..');

const staticImportPattern = /\b(?:import|export)\b[\s\S]*?(__CORE_STATIC_IMPORT_\d+__)/g;

type StringLiteral = {
  start: number;
  end: number;
  value: string;
};

/** Mask comments and non-module strings while retaining placeholders for module specifiers. */
function stripCommentsAndStrings(source: string): { code: string; moduleSpecifiers: Map<string, string> } {
  const chars = source.split('');
  const literals: StringLiteral[] = [];
  let index = 0;

  const mask = (start: number, end: number): void => {
    for (let position = start; position < end; position += 1) {
      if (chars[position] !== '\n' && chars[position] !== '\r') {
        chars[position] = ' ';
      }
    }
  };

  while (index < source.length) {
    if (source.startsWith('//', index)) {
      const start = index;
      index += 2;
      while (index < source.length && source[index] !== '\n') {
        index += 1;
      }
      mask(start, index);
      continue;
    }

    if (source.startsWith('/*', index)) {
      const start = index;
      index += 2;
      while (index < source.length && !source.startsWith('*/', index)) {
        index += 1;
      }
      index = Math.min(source.length, index + 2);
      mask(start, index);
      continue;
    }

    const quote = source[index];
    if (quote === "'" || quote === '"' || quote === '`') {
      const start = index;
      index += 1;
      while (index < source.length) {
        if (source[index] === '\\') {
          index += 2;
          continue;
        }
        if (source[index] === quote) {
          index += 1;
          break;
        }
        index += 1;
      }
      literals.push({ start, end: index, value: source.slice(start + 1, Math.max(start + 1, index - 1)) });
      mask(start, index);
      continue;
    }

    index += 1;
  }

  const masked = chars.join('');
  const moduleSpecifiers = new Map<string, string>();
  const replacements = literals.filter(({ start }) => {
    const prefix = masked.slice(0, start).trimEnd();
    return /\bfrom$/.test(prefix) || /\bimport$/.test(prefix);
  });

  let code = masked;
  for (let index = replacements.length - 1; index >= 0; index -= 1) {
    const literal = replacements[index];
    const token = `__CORE_STATIC_IMPORT_${index}__`;
    moduleSpecifiers.set(token, literal.value);
    code = code.slice(0, literal.start) + token + code.slice(literal.end);
  }

  return { code, moduleSpecifiers };
}

function isValueImport(declaration: string, token: string): boolean {
  const normalized = declaration.replace(token, '').replace(/\s+/g, ' ').trim();
  const keyword = normalized.startsWith('export') ? 'export' : 'import';
  const clause = normalized.slice(keyword.length).trimStart();

  if (clause.startsWith('type ') || clause === 'type') {
    return false;
  }

  const fromIndex = clause.lastIndexOf(' from ');
  const bindings = (fromIndex >= 0 ? clause.slice(0, fromIndex) : clause).trim();
  if (bindings.startsWith('{') && bindings.endsWith('}')) {
    return bindings
      .slice(1, -1)
      .split(',')
      .some((specifier) => !specifier.trimStart().startsWith('type '));
  }

  return true;
}

function resolveSourceImport(importer: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) {
    return null;
  }

  const requested = normalize(join(dirname(importer), specifier));
  const requestedExtension = extname(requested);
  const extensionlessBase = requestedExtension === '.js' ? requested.slice(0, -3) : requested;
  const candidates = [
    requested,
    ...(requestedExtension === '.js'
      ? [extensionlessBase + '.ts', extensionlessBase + '.tsx']
      : requestedExtension === ''
      ? [requested + '.ts', requested + '.tsx']
      : []),
    join(extensionlessBase, 'index.ts'),
    join(extensionlessBase, 'index.tsx'),
  ];

  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function coreProductionFiles(): string[] {
  const visited = new Set<string>();
  const pending = [coreEntry];

  while (pending.length > 0) {
    const file = pending.pop()!;
    if (visited.has(file)) {
      continue;
    }
    visited.add(file);

    const { code, moduleSpecifiers } = stripCommentsAndStrings(readFileSync(file, 'utf8'));
    for (const match of code.matchAll(staticImportPattern)) {
      const specifier = moduleSpecifiers.get(match[1]);
      if (!specifier || !isValueImport(match[0], match[1])) {
        continue;
      }
      const resolved = resolveSourceImport(file, specifier);
      if (resolved && !visited.has(resolved)) {
        pending.push(resolved);
      }
    }
  }

  return [...visited];
}

it('keeps the core production graph away from CLI and presentation modules', () => {
  const forbidden = [
    /(?:^|\/)cli\.[cm]?[jt]sx?$/,
    /(?:^|\/)app\.[cm]?[jt]sx?$/,
    /^(?:components|context|hooks)(?:\/|$)/,
    /^(?:commands|terminal)(?:\/|$)/,
  ];

  const violations = coreProductionFiles()
    .map((file) => relative(sourceRoot, file))
    .filter((file) => forbidden.some((pattern) => pattern.test(file)));

  expect(violations).toEqual([]);
});

it('imports the core entry without CLI process or filesystem side effects', async () => {
  const stdoutWrites: unknown[] = [];
  const stderrWrites: unknown[] = [];
  const exitCalls: unknown[] = [];
  const stdoutWrite = process.stdout.write;
  const stderrWrite = process.stderr.write;
  const processExit = process.exit;
  const listeners = new Map(process.eventNames().map((event) => [event, process.listeners(event as any)]));
  const probeRoot = mkdtempSync(join(tmpdir(), 'term2-core-import-'));
  const probeDirectories = {
    TMPDIR: join(probeRoot, 'tmp'),
    XDG_CONFIG_HOME: join(probeRoot, 'config'),
    XDG_DATA_HOME: join(probeRoot, 'data'),
    XDG_CACHE_HOME: join(probeRoot, 'cache'),
  };
  const previousEnvironment = new Map(Object.keys(probeDirectories).map((key) => [key, process.env[key]]));
  for (const directory of Object.values(probeDirectories)) {
    mkdirSync(directory);
  }
  for (const [key, value] of Object.entries(probeDirectories)) {
    process.env[key] = value;
  }
  let probeDirectoryContents: string[][] = [];

  process.stdout.write = ((chunk: unknown) => {
    stdoutWrites.push(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    stderrWrites.push(chunk);
    return true;
  }) as typeof process.stderr.write;
  process.exit = ((code?: number) => {
    exitCalls.push(code);
    throw new Error(`core import called process.exit(${code ?? ''})`);
  }) as typeof process.exit;

  try {
    const core = await import('./index.js');
    expect(typeof core.createSessionRuntime).toBe('function');
    await new Promise<void>((resolveImmediate) => setImmediate(resolveImmediate));
    probeDirectoryContents = Object.values(probeDirectories).map((directory) => readdirSync(directory));
  } finally {
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
    process.exit = processExit;
    for (const [key, value] of previousEnvironment) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    rmSync(probeRoot, { recursive: true, force: true });
  }

  expect(stdoutWrites).toEqual([]);
  expect(stderrWrites).toEqual([]);
  expect(exitCalls).toEqual([]);
  expect(new Map(process.eventNames().map((event) => [event, process.listeners(event as any)]))).toEqual(listeners);
  expect(probeDirectoryContents).toEqual([[], [], [], []]);
});

it('keeps the conversation runtime factory on the core entry', () => {
  const factory = readFileSync(resolve(sourceRoot, 'services/conversation/conversation-runtime-factory.ts'), 'utf8');

  expect(factory).toContain('../../core/index.js');
  expect(factory).not.toContain('../session/session-composition.js');
});

it('does not pull the CLI log writer into the core production graph', () => {
  expect(coreProductionFiles().some((file) => basename(file) === 'conversation-log-writer.ts')).toBe(false);
});
