import { spawn } from 'node:child_process';
import { access, open, realpath as realpathFromDisk } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const EXIT_CODES = {
  pass: 0,
  'gate-failed': 1,
  'scope-failed': 2,
  'contract-failed': 3,
  'invalid-input': 4,
} as const;

export type ExitClassification = keyof typeof EXIT_CODES;
export type GateName = 'test' | 'typecheck' | 'script-typecheck' | 'format';

interface GateSpec {
  name: string;
  argv: readonly string[];
  test?: boolean;
  appendPaths?: boolean;
}

export interface CommandInvocation {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  signal?: string;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
}

export type CommandRunner = (invocation: CommandInvocation) => Promise<CommandResult>;
export type ReadFile = (file: string, encoding: 'utf8') => Promise<string>;
export type PathExists = (file: string) => Promise<boolean>;
export interface BoundedText {
  value: string;
  truncated: boolean;
}

export interface BoundedFileHandle {
  read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}

export type BoundedFileOpener = (file: string, flags: 'r') => Promise<BoundedFileHandle>;

export type AgentEvidence = Record<string, unknown>;
export type AgentEvidenceCollector = () => AgentEvidence | unknown | Promise<AgentEvidence | unknown>;

export interface CandidateGateOptions {
  worktree: string;
  primary: string;
  branch: string;
  base: string;
  baseCommit?: string;
  allowExact: readonly string[];
  allowPrefixes: readonly string[];
  gates: readonly string[];
  timeoutMs?: number;
  maxOutputBytes?: number;
  runner?: CommandRunner;
  brief?: string;
  requiredHeadings?: readonly string[];
  readFile?: ReadFile;
  pathExists?: PathExists;
  realpath?: (value: string) => Promise<string>;
  evidence?: AgentEvidence;
  evidenceCollector?: AgentEvidenceCollector;
  evidenceFile?: string;
}

export interface ParsedArguments {
  worktree: string;
  primary: string;
  branch: string;
  base: string;
  baseCommit: string | undefined;
  allowExact: string[];
  allowPrefixes: string[];
  gates: GateName[];
  timeoutMs: number;
  maxOutputBytes: number;
  brief: string | undefined;
  requiredHeadings: string[];
  evidence: AgentEvidence | undefined;
  evidenceFile?: string;
}

export interface PnpmGate {
  command: 'pnpm';
  args: string[];
  env: Record<string, string>;
}

export interface BriefHeadingReport {
  ok: boolean;
  headings: string[];
  missing: string[];
  truncated: boolean;
}

export interface GateReport {
  name: string;
  status: 'passed' | 'failed' | 'timeout' | 'runner-error';
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

export interface CandidateGateReport {
  schemaVersion: 1;
  ok: boolean;
  classification: ExitClassification;
  worktree: string;
  primary: string;
  branch: string;
  base: string;
  head: string;
  checks: {
    registeredWorktree: boolean;
    nonPrimaryWorktree: boolean;
    exactBranch: boolean;
    exactBase: boolean;
    registeredPrimaryWorktree: boolean;
    allowlist: boolean;
    brief: boolean;
  };
  touchSet: string[];
  touchSetTotal: number;
  touchSetTruncated: boolean;
  scopeViolations: string[];
  scopeViolationsTotal: number;
  scopeViolationsTruncated: boolean;
  brief?: BriefHeadingReport;
  gates: GateReport[];
  evidence?: AgentEvidence;
  evidenceTruncated: boolean;
  errors: string[];
}

export interface MainDependencies {
  runner?: CommandRunner;
  readFile?: ReadFile;
  pathExists?: PathExists;
  realpath?: (value: string) => Promise<string>;
  evidenceCollector?: AgentEvidenceCollector;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 2_147_483_647;
const DEFAULT_MAX_OUTPUT_BYTES = 20_000;
const MAX_OUTPUT_BYTES = 100_000;
const DEFAULT_GATES: readonly GateName[] = ['test', 'typecheck', 'format'];
const GATE_NAMES = new Set<GateName>(['test', 'typecheck', 'script-typecheck', 'format']);
const DEFAULT_GATE_SPECS: readonly GateSpec[] = [
  { name: 'test', argv: ['test'], test: true },
  { name: 'typecheck', argv: ['typecheck'], appendPaths: false },
  {
    name: 'script-typecheck',
    argv: [
      'exec',
      'tsc',
      '--ignoreConfig',
      '--noEmit',
      '--target',
      'ES2022',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      '--strict',
      '--esModuleInterop',
      '--skipLibCheck',
      '--types',
      'node',
      'scripts/candidate-gates.ts',
      'scripts/candidate-gates.test.ts',
    ],
    appendPaths: false,
  },
  { name: 'format', argv: ['exec', 'prettier', '--check', '--'] },
];
const MUTATING_PNPM_OPERATIONS = new Set(['install', 'add', 'remove', 'publish', 'release', 'version']);
const SHELL_LIKE_ARGUMENT = /[;&|`$()<>\n\r]/u;

export function trimOutput(value: string, maxOutputBytes: number): { value: string; truncated: boolean } {
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes <= maxOutputBytes) return { value, truncated: false };
  const buffer = Buffer.from(value, 'utf8');
  let end = maxOutputBytes;
  while (end > 0) {
    let start = end - 1;
    while (start > 0 && (buffer[start]! & 0xc0) === 0x80) start -= 1;
    const byte = buffer[start]!;
    if ((byte & 0xc0) !== 0x80) {
      const expectedLength = byte < 0x80 ? 1 : byte < 0xe0 ? 2 : byte < 0xf0 ? 3 : 4;
      if (start + expectedLength <= end) break;
    }
    end -= 1;
  }
  return { value: buffer.subarray(0, end).toString('utf8'), truncated: true };
}

export async function readBoundedFile(
  file: string,
  maxOutputBytes: number,
  opener: BoundedFileOpener = open,
): Promise<BoundedText> {
  const handle = await opener(file, 'r');
  try {
    const buffer = Buffer.alloc(maxOutputBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const decoder = new StringDecoder('utf8');
    const prefix = decoder.write(buffer.subarray(0, Math.min(bytesRead, maxOutputBytes)));
    // Do not append decoder.end(): a byte-limited read may end inside a
    // multibyte sequence, and StringDecoder would turn that incomplete suffix
    // into a replacement character that exceeds the byte budget.
    const incomplete = decoder.end();
    const bounded = trimOutput(prefix, maxOutputBytes);
    return {
      value: bounded.value,
      truncated: bytesRead > maxOutputBytes || incomplete.length > 0 || bounded.truncated,
    };
  } finally {
    await handle.close();
  }
}

function boundStringList(values: readonly string[], maxOutputBytes: number): { values: string[]; truncated: boolean } {
  const bounded: string[] = [];
  let bytes = 0;
  for (const value of values) {
    const nextBytes = Buffer.byteLength(value, 'utf8') + (bounded.length > 0 ? 1 : 0);
    if (bytes + nextBytes > maxOutputBytes) return { values: bounded, truncated: true };
    bounded.push(value);
    bytes += nextBytes;
  }
  return { values: bounded, truncated: false };
}

function boundedMarker(value: unknown, fallback: string, maxOutputBytes: number): string {
  return typeof value === 'string' ? trimOutput(value, Math.min(maxOutputBytes, 256)).value : fallback;
}

function boundEvidence(value: unknown, maxOutputBytes: number): { value: AgentEvidence; truncated: boolean } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {
      value: {
        status: 'invalid',
        settlement: 'unknown',
        truncated: true,
        text: trimOutput(String(value), maxOutputBytes).value,
      },
      truncated: true,
    };
  }
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    return {
      value: {
        status: 'error',
        settlement: 'unknown',
        truncated: true,
        text: trimOutput(String(error), maxOutputBytes).value,
      },
      truncated: true,
    };
  }
  if (typeof serialized === 'string' && Buffer.byteLength(serialized, 'utf8') <= maxOutputBytes)
    return { value: value as AgentEvidence, truncated: false };
  const input = value as Record<string, unknown>;
  return {
    value: {
      status: boundedMarker(input.status, 'truncated', maxOutputBytes),
      settlement: boundedMarker(input.settlement, 'unknown', maxOutputBytes),
      truncated: true,
      text: trimOutput(serialized ?? '[unserializable evidence]', maxOutputBytes).value,
    },
    truncated: true,
  };
}

function normalizePath(value: string): string {
  return value.trim().replaceAll('\\', '/').replace(/^\.\//, '');
}

const pathExistsFromDisk: PathExists = async (file) => {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
};

async function readBoundedText(
  file: string,
  maxOutputBytes: number,
  readFile: ReadFile | undefined,
): Promise<BoundedText> {
  if (readFile) return trimOutput(await readFile(file, 'utf8'), maxOutputBytes);
  return readBoundedFile(file, maxOutputBytes);
}

async function filterExistingPaths(paths: readonly string[], cwd: string, pathExists: PathExists): Promise<string[]> {
  const existing = await Promise.all(paths.map((value) => pathExists(path.resolve(cwd, value))));
  return paths.filter((_, index) => existing[index]);
}

function validateRepoRelativePath(value: string, name: string): string {
  const normalized = normalizePath(value);
  if (
    !normalized ||
    path.posix.isAbsolute(normalized) ||
    /^[A-Za-z]:\//u.test(normalized) ||
    normalized.split('/').some((segment) => segment === '..')
  ) {
    throw new Error(`${name} must be a repo-relative path without traversal: ${value}`);
  }
  return normalized;
}

function validateGateSpec(spec: GateSpec): GateSpec {
  if (!/^[A-Za-z0-9._-]+$/u.test(spec.name)) throw new Error(`Unsafe gate name: ${spec.name}`);
  if (spec.argv.length === 0) throw new Error(`Gate ${spec.name} has no argv`);
  if (spec.argv.length > 128 || Buffer.byteLength(JSON.stringify(spec.argv), 'utf8') > MAX_OUTPUT_BYTES) {
    throw new Error(`Gate ${spec.name} argv is too large`);
  }
  for (const argument of spec.argv) {
    if (!argument || SHELL_LIKE_ARGUMENT.test(argument)) throw new Error(`Unsafe argv in gate ${spec.name}`);
    if (path.posix.isAbsolute(argument) || argument.split('/').some((segment) => segment === '..')) {
      throw new Error(`Repo-relative gate argv required in gate ${spec.name}`);
    }
    if (argument === '--dir' || argument === '-C' || argument.startsWith('--dir=') || /^-C.+/u.test(argument)) {
      throw new Error(`Nested pnpm directory option is not allowed in gate ${spec.name}`);
    }
    if (MUTATING_PNPM_OPERATIONS.has(argument)) throw new Error(`Mutating pnpm operation is not allowed: ${argument}`);
  }
  return { name: spec.name, argv: [...spec.argv], test: spec.test === true, appendPaths: spec.appendPaths !== false };
}

function getGateSpecs(): Map<string, GateSpec> {
  const specs = DEFAULT_GATE_SPECS;
  return new Map(
    specs.map((spec) => {
      const validated = validateGateSpec(spec);
      return [validated.name, validated];
    }),
  );
}

function parsePositiveInteger(value: string, name: string, maximum = Number.MAX_SAFE_INTEGER): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > maximum) {
    throw new Error(`${name} must be a positive integer at most ${maximum}`);
  }
  return parsed;
}

function assertSafeGitRef(value: string): void {
  if (!/^[A-Za-z0-9._/@-]+$/u.test(value) || value.startsWith('-')) {
    throw new Error(`Unsafe git ref: ${value}`);
  }
}

function requireArgument(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  if (Buffer.byteLength(value, 'utf8') > MAX_OUTPUT_BYTES) throw new Error(`${flag} value is too large`);
  return value;
}

export function parseArguments(argv: readonly string[]): ParsedArguments {
  const values: Omit<ParsedArguments, 'worktree' | 'primary' | 'branch' | 'base'> &
    Partial<Pick<ParsedArguments, 'worktree' | 'primary' | 'branch' | 'base'>> = {
    baseCommit: undefined,
    allowExact: [],
    allowPrefixes: [],
    gates: [],
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
    brief: undefined,
    requiredHeadings: [],
    evidence: undefined,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    switch (flag) {
      case '--worktree':
        values.worktree = requireArgument(argv, index++, flag);
        break;
      case '--primary':
        values.primary = requireArgument(argv, index++, flag);
        break;
      case '--branch':
        values.branch = requireArgument(argv, index++, flag);
        break;
      case '--base':
        values.base = requireArgument(argv, index++, flag);
        break;
      case '--base-commit':
        values.baseCommit = requireArgument(argv, index++, flag);
        break;
      case '--allow':
        values.allowExact.push(validateRepoRelativePath(requireArgument(argv, index++, flag), flag));
        break;
      case '--allow-prefix':
        values.allowPrefixes.push(validateRepoRelativePath(requireArgument(argv, index++, flag), flag));
        break;
      case '--gate': {
        const gate = requireArgument(argv, index++, flag) as GateName;
        if (!GATE_NAMES.has(gate)) throw new Error(`Unsupported gate: ${gate}`);
        values.gates.push(gate);
        break;
      }
      case '--timeout-ms':
        values.timeoutMs = parsePositiveInteger(requireArgument(argv, index++, flag), 'timeout-ms', MAX_TIMEOUT_MS);
        break;
      case '--max-output-bytes':
        values.maxOutputBytes = parsePositiveInteger(requireArgument(argv, index++, flag), 'max-output-bytes');
        if (values.maxOutputBytes > MAX_OUTPUT_BYTES)
          throw new Error(`max-output-bytes must be at most ${MAX_OUTPUT_BYTES}`);
        break;
      case '--brief':
        values.brief = requireArgument(argv, index++, flag);
        break;
      case '--require-heading':
        values.requiredHeadings.push(requireArgument(argv, index++, flag));
        break;
      case '--evidence-json': {
        const raw = requireArgument(argv, index++, flag);
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
          throw new Error('--evidence-json must be a JSON object');
        values.evidence = parsed as AgentEvidence;
        break;
      }
      case '--evidence-file':
        values.evidenceFile = requireArgument(argv, index++, flag);
        if (!path.isAbsolute(values.evidenceFile)) throw new Error('--evidence-file must be an absolute path');
        break;
      case '--help':
        throw new Error('HELP');
      default:
        throw new Error(`Unknown argument: ${flag}`);
    }
  }

  for (const name of ['worktree', 'primary', 'branch', 'base'] as const) {
    if (!values[name]) throw new Error(`--${name} is required`);
  }
  assertSafeGitRef(values.base!);
  if (!path.isAbsolute(values.worktree!) || !path.isAbsolute(values.primary!)) {
    throw new Error('--worktree and --primary must be absolute paths');
  }
  if (path.resolve(values.worktree!) === path.resolve(values.primary!))
    throw new Error('--worktree must differ from --primary');

  return {
    worktree: values.worktree!,
    primary: values.primary!,
    branch: values.branch!,
    base: values.base!,
    baseCommit: values.baseCommit,
    allowExact: values.allowExact,
    allowPrefixes: values.allowPrefixes,
    gates: values.gates.length > 0 ? values.gates : [...DEFAULT_GATES],
    timeoutMs: values.timeoutMs,
    maxOutputBytes: values.maxOutputBytes,
    brief: values.brief,
    requiredHeadings: values.requiredHeadings,
    evidence: values.evidence,
    evidenceFile: values.evidenceFile,
  };
}

export function buildPnpmGate(name: GateName, canonicalWorktree: string, paths: readonly string[] = []): PnpmGate {
  const spec = DEFAULT_GATE_SPECS.find((candidate) => candidate.name === name);
  if (!spec) throw new Error(`Unsupported gate: ${name}`);
  const validated = validateGateSpec(spec);
  if (!path.isAbsolute(canonicalWorktree)) throw new Error('canonical worktree must be absolute');
  const safePaths = paths.map((value) => validateRepoRelativePath(value, 'gate path'));
  const gatePaths = validated.test
    ? safePaths.filter((value) => /(?:^|\/)[^/]+\.(?:test|spec)\.(?:js|jsx|mjs|cjs|ts|tsx)$/u.test(value))
    : safePaths;
  const positionalPaths = gatePaths.map((value) => (value.startsWith('-') ? `./${value}` : value));
  const args = validated.appendPaths === false ? [...validated.argv] : [...validated.argv, ...positionalPaths];
  return {
    command: 'pnpm',
    args: ['--dir', canonicalWorktree, ...args],
    env: validated.test || name === 'test' ? { NODE_ENV: 'test' } : {},
  };
}

export function lintBriefHeadings(markdown: string, requiredHeadings: readonly string[]): BriefHeadingReport {
  const headings = markdown.split(/\r?\n/u).flatMap((line) => {
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/u.exec(line);
    return match ? [match[2]!.trim()] : [];
  });
  const missing = requiredHeadings.filter((heading) => !headings.includes(heading));
  return { ok: missing.length === 0, headings, missing: [...missing], truncated: false };
}

function parseWorktreeRegistry(value: string): Array<{ path: string; head?: string; branch?: string }> {
  const entries: Array<{ path: string; head?: string; branch?: string }> = [];
  let current: { path?: string; head?: string; branch?: string } = {};
  const flush = () => {
    if (current.path && path.isAbsolute(current.path)) {
      entries.push({ path: current.path, head: current.head, branch: current.branch });
    }
    current = {};
  };
  for (const line of value.split(/\r?\n/u)) {
    if (line === '') {
      flush();
    } else if (line.startsWith('worktree ')) {
      current.path = line.slice('worktree '.length).trim();
    } else if (line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length).trim();
    } else if (line.startsWith('branch refs/heads/')) {
      current.branch = line.slice('branch refs/heads/'.length).trim();
    }
  }
  flush();
  return entries;
}

async function runCommand(
  runner: CommandRunner,
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  maxOutputBytes: number,
  env: Record<string, string> = {},
): Promise<CommandResult> {
  return runner({ command, args, cwd, env, timeoutMs, maxOutputBytes });
}

async function runGit(
  runner: CommandRunner,
  cwd: string,
  args: string[],
  timeoutMs: number,
  maxOutputBytes: number,
): Promise<string> {
  const result = await runCommand(runner, 'git', args, cwd, timeoutMs, maxOutputBytes);
  if (result.timedOut || result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed${result.timedOut ? ' (timeout)' : ` (exit ${result.exitCode ?? 'unknown'})`}: ${
        trimOutput(result.stderr, maxOutputBytes).value
      }`,
    );
  }
  if (result.stdoutTruncated || Buffer.byteLength(result.stdout, 'utf8') > maxOutputBytes) {
    throw new Error(`git ${args.join(' ')} output exceeded the configured bound`);
  }
  return result.stdout.trim();
}

export async function collectTouchSet(options: {
  runner: CommandRunner;
  cwd: string;
  base: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}): Promise<string[]> {
  assertSafeGitRef(options.base);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const commands = [
    ['diff', '--name-only', `${options.base}...HEAD`],
    ['diff', '--name-only', '--cached'],
    ['diff', '--name-only'],
    ['ls-files', '--others', '--exclude-standard'],
  ];
  const outputs: string[] = [];
  for (const args of commands) outputs.push(await runGit(options.runner, options.cwd, args, timeoutMs, maxOutputBytes));
  return [...new Set(outputs.flatMap((output) => output.split(/\r?\n/u).map(normalizePath).filter(Boolean)))].sort();
}

function pathIsAllowed(candidate: string, exact: readonly string[], prefixes: readonly string[]): boolean {
  const normalized = normalizePath(candidate);
  if (exact.map(normalizePath).includes(normalized)) return true;
  return prefixes.map(normalizePath).some((prefix) => {
    const cleanPrefix = prefix.replace(/\/+$/u, '');
    return normalized === cleanPrefix || normalized.startsWith(`${cleanPrefix}/`);
  });
}

function emptyReport(options: CandidateGateOptions): CandidateGateReport {
  return {
    schemaVersion: 1,
    ok: false,
    classification: 'contract-failed',
    worktree: path.resolve(options.worktree),
    primary: path.resolve(options.primary),
    branch: options.branch,
    base: options.base,
    head: '',
    checks: {
      registeredWorktree: false,
      nonPrimaryWorktree: path.resolve(options.worktree) !== path.resolve(options.primary),
      exactBranch: false,
      exactBase: false,
      registeredPrimaryWorktree: false,
      allowlist: false,
      brief: true,
    },
    touchSet: [],
    touchSetTotal: 0,
    touchSetTruncated: false,
    scopeViolations: [],
    scopeViolationsTotal: 0,
    scopeViolationsTruncated: false,
    evidenceTruncated: false,
    gates: [],
    errors: [],
  };
}

export async function runCandidateGates(options: CandidateGateOptions): Promise<CandidateGateReport> {
  const report = emptyReport(options);
  const runner = options.runner ?? createDefaultRunner();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const requestedOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > MAX_TIMEOUT_MS ||
    !Number.isInteger(requestedOutputBytes) ||
    requestedOutputBytes <= 0
  ) {
    report.errors.push('timeout and output bounds must be positive integers');
    return report;
  }
  const maxOutputBytes = Math.min(requestedOutputBytes, MAX_OUTPUT_BYTES);
  if (!path.isAbsolute(options.worktree) || !path.isAbsolute(options.primary)) {
    report.errors.push('--worktree and --primary must be absolute paths');
    return report;
  }
  const canonicalize = options.realpath ?? realpathFromDisk;
  let candidate: string;
  let primary: string;
  try {
    [candidate, primary] = await Promise.all([canonicalize(options.worktree), canonicalize(options.primary)]);
  } catch (error) {
    report.errors.push(
      `unable to canonicalize worktree identity: ${error instanceof Error ? error.message : String(error)}`,
    );
    return report;
  }
  if (!path.isAbsolute(candidate) || !path.isAbsolute(primary)) {
    report.errors.push('canonical worktree identity must be absolute');
    return report;
  }
  report.worktree = candidate;
  report.primary = primary;
  try {
    assertSafeGitRef(options.base);
  } catch (error) {
    report.errors.push(error instanceof Error ? error.message : String(error));
    return report;
  }
  let allowExact: string[];
  let allowPrefixes: string[];
  try {
    allowExact = options.allowExact.map((value) => validateRepoRelativePath(value, 'allow entry'));
    allowPrefixes = options.allowPrefixes.map((value) => validateRepoRelativePath(value, 'allow prefix'));
  } catch (error) {
    report.errors.push(error instanceof Error ? error.message : String(error));
    return report;
  }

  try {
    const registry = parseWorktreeRegistry(
      await runGit(runner, primary, ['worktree', 'list', '--porcelain'], timeoutMs, MAX_OUTPUT_BYTES),
    );
    const registeredPrimary = registry.find((entry) => entry.path === primary);
    report.checks.registeredPrimaryWorktree = registeredPrimary !== undefined;
    if (!report.checks.registeredPrimaryWorktree) {
      report.errors.push('primary path is not a registered worktree');
      return report;
    }
    const registered = registry.find((entry) => entry.path === candidate);
    report.checks.registeredWorktree = registered !== undefined;
    report.checks.nonPrimaryWorktree = candidate !== primary;
    report.head = registered?.head ?? '';
    report.checks.exactBranch = registered?.branch === options.branch;
    const actualBranch = await runGit(runner, candidate, ['branch', '--show-current'], timeoutMs, MAX_OUTPUT_BYTES);
    report.checks.exactBranch = report.checks.exactBranch && actualBranch === options.branch;

    const baseRevision = await runGit(
      runner,
      candidate,
      ['rev-parse', '--verify', `${options.base}^{commit}`],
      timeoutMs,
      MAX_OUTPUT_BYTES,
    );
    const mergeBase = await runGit(
      runner,
      candidate,
      ['merge-base', 'HEAD', options.base],
      timeoutMs,
      MAX_OUTPUT_BYTES,
    );
    report.checks.exactBase = mergeBase === baseRevision && (!options.baseCommit || mergeBase === options.baseCommit);

    if (
      !report.checks.registeredWorktree ||
      !report.checks.nonPrimaryWorktree ||
      !report.checks.exactBranch ||
      !report.checks.exactBase
    ) {
      report.errors.push('candidate worktree, branch, or base contract failed');
      return report;
    }

    const allTouchSet = await collectTouchSet({
      runner,
      cwd: candidate,
      base: options.base,
      timeoutMs,
      maxOutputBytes: MAX_OUTPUT_BYTES,
    });
    const existingTouchSet = await filterExistingPaths(
      allTouchSet,
      candidate,
      options.pathExists ?? pathExistsFromDisk,
    );
    report.touchSetTotal = allTouchSet.length;
    const boundedTouchSet = boundStringList(allTouchSet, maxOutputBytes);
    report.touchSet = boundedTouchSet.values;
    report.touchSetTruncated = boundedTouchSet.truncated;
    report.scopeViolations = allTouchSet.filter(
      (touchedPath) => !pathIsAllowed(touchedPath, allowExact, allowPrefixes),
    );
    report.scopeViolationsTotal = report.scopeViolations.length;
    const boundedViolations = boundStringList(report.scopeViolations, maxOutputBytes);
    report.scopeViolations = boundedViolations.values;
    report.scopeViolationsTruncated = boundedViolations.truncated;
    report.checks.allowlist = report.scopeViolationsTotal === 0;
    if (!report.checks.allowlist) {
      report.classification = 'scope-failed';
      return report;
    }

    if (options.requiredHeadings && options.requiredHeadings.length > 0 && !options.brief) {
      report.checks.brief = false;
      report.classification = 'contract-failed';
      report.errors.push('required brief headings were provided without a brief');
      return report;
    }

    if (options.brief && options.requiredHeadings && options.requiredHeadings.length > 0) {
      const briefInput = await readBoundedText(options.brief, maxOutputBytes, options.readFile);
      const boundedRequiredHeadings = boundStringList(options.requiredHeadings, maxOutputBytes);
      report.brief = lintBriefHeadings(briefInput.value, boundedRequiredHeadings.values);
      const boundedHeadings = boundStringList(report.brief.headings, maxOutputBytes);
      const boundedMissing = boundStringList(report.brief.missing, maxOutputBytes);
      report.brief.headings = boundedHeadings.values;
      report.brief.missing = boundedMissing.values;
      report.brief.truncated = briefInput.truncated || boundedRequiredHeadings.truncated;
      report.checks.brief = report.brief.ok;
      if (!report.checks.brief) {
        report.classification = 'contract-failed';
        report.errors.push(`brief is missing required headings: ${report.brief.missing.join(', ')}`);
        return report;
      }
    }

    let evidenceInput: unknown = options.evidence;
    if (options.evidenceFile) {
      const raw = await readBoundedText(options.evidenceFile, maxOutputBytes, options.readFile);
      if (raw.truncated) {
        report.evidence = { status: 'truncated', settlement: 'unknown', truncated: true, text: raw.value };
        report.evidenceTruncated = true;
      } else {
        evidenceInput = JSON.parse(raw.value);
      }
    }
    if (options.evidenceCollector) evidenceInput = await options.evidenceCollector();
    if (evidenceInput !== undefined) {
      const boundedEvidence = boundEvidence(evidenceInput, maxOutputBytes);
      report.evidence = boundedEvidence.value;
      report.evidenceTruncated = boundedEvidence.truncated;
    }

    const gateSpecs = getGateSpecs();
    for (const gate of options.gates) {
      const spec = gateSpecs.get(gate);
      if (!spec) {
        report.gates.push({
          name: gate,
          status: 'runner-error',
          exitCode: null,
          stdout: '',
          stderr: `Unsupported gate: ${gate}`,
          truncated: false,
        });
        continue;
      }
      const command = buildPnpmGate(gate as GateName, candidate, existingTouchSet);
      try {
        const result = await runCommand(
          runner,
          command.command,
          command.args,
          candidate,
          timeoutMs,
          MAX_OUTPUT_BYTES,
          command.env,
        );
        const stdout = trimOutput(result.stdout, maxOutputBytes);
        const stderr = trimOutput(result.stderr, maxOutputBytes);
        report.gates.push({
          name: gate,
          status: result.timedOut ? 'timeout' : result.exitCode === 0 ? 'passed' : 'failed',
          exitCode: result.exitCode,
          stdout: stdout.value,
          stderr: stderr.value,
          truncated:
            stdout.truncated || stderr.truncated || result.stdoutTruncated === true || result.stderrTruncated === true,
        });
      } catch (error) {
        report.gates.push({
          name: gate,
          status: 'runner-error',
          exitCode: null,
          stdout: '',
          stderr: trimOutput(error instanceof Error ? error.message : String(error), maxOutputBytes).value,
          truncated: false,
        });
      }
    }
    report.ok = report.gates.every((gate) => gate.status === 'passed');
    report.classification = report.ok ? 'pass' : 'gate-failed';
    return report;
  } catch (error) {
    report.errors.push(trimOutput(error instanceof Error ? error.message : String(error), maxOutputBytes).value);
    report.classification = 'contract-failed';
    return report;
  }
}

export function createDefaultRunner(): CommandRunner {
  return (invocation) =>
    new Promise<CommandResult>((resolve) => {
      const child = spawn(invocation.command, invocation.args, {
        cwd: invocation.cwd,
        shell: false,
        env: { ...process.env, ...invocation.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let stdoutTruncated = false;
      let stderrTruncated = false;
      let settled = false;
      let graceTimer: NodeJS.Timeout | undefined;
      let hardTimer: NodeJS.Timeout | undefined;
      const append = (target: 'stdout' | 'stderr', text: string) => {
        const next = target === 'stdout' ? stdout + text : stderr + text;
        const bounded = trimOutput(next, invocation.maxOutputBytes);
        if (bounded.truncated) {
          if (target === 'stdout') stdoutTruncated = true;
          else stderrTruncated = true;
        }
        if (target === 'stdout') stdout = bounded.value;
        else stderr = bounded.value;
      };
      const stdoutDecoder = new StringDecoder('utf8');
      const stderrDecoder = new StringDecoder('utf8');
      let decodersFlushed = false;
      const flushDecoders = () => {
        if (decodersFlushed) return;
        decodersFlushed = true;
        append('stdout', stdoutDecoder.end());
        append('stderr', stderrDecoder.end());
      };
      const finish = (result: CommandResult) => {
        if (settled) return;
        flushDecoders();
        settled = true;
        clearTimeout(timer);
        if (graceTimer) clearTimeout(graceTimer);
        if (hardTimer) clearTimeout(hardTimer);
        resolve(result);
      };
      child.stdout.on('data', (chunk: Buffer) => append('stdout', stdoutDecoder.write(chunk)));
      child.stderr.on('data', (chunk: Buffer) => append('stderr', stderrDecoder.write(chunk)));
      const timer = setTimeout(() => {
        timedOut = true;
        const signalChild = (signal: NodeJS.Signals) => {
          if (child.pid && process.platform !== 'win32') {
            try {
              process.kill(-child.pid, signal);
              return;
            } catch {
              // The process may have exited between timeout and signalling.
            }
          }
          child.kill(signal);
        };
        signalChild('SIGTERM');
        graceTimer = setTimeout(() => signalChild('SIGKILL'), 250);
        hardTimer = setTimeout(
          () => finish({ exitCode: null, stdout, stderr, timedOut, stdoutTruncated, stderrTruncated }),
          500,
        );
      }, invocation.timeoutMs);
      child.on('error', (error) => {
        finish({
          exitCode: null,
          stdout,
          stderr: `${stderr}${error.message}`,
          timedOut,
          stdoutTruncated,
          stderrTruncated,
        });
      });
      child.on('close', (exitCode, signal) => {
        finish({ exitCode, signal: signal ?? undefined, stdout, stderr, timedOut, stdoutTruncated, stderrTruncated });
      });
    });
}

function classificationOf(value: unknown): ExitClassification {
  if (value && typeof value === 'object' && 'classification' in value) {
    const classification = value.classification;
    if (typeof classification === 'string' && Object.prototype.hasOwnProperty.call(EXIT_CODES, classification)) {
      return classification as ExitClassification;
    }
  }
  return 'invalid-input';
}

export function serializeBoundedJson(value: unknown): { value: string; truncated: boolean } {
  const budget = MAX_OUTPUT_BYTES - 1;
  try {
    const serialized = JSON.stringify(value);
    if (typeof serialized === 'string' && Buffer.byteLength(serialized, 'utf8') <= budget) {
      return { value: serialized, truncated: false };
    }
  } catch {
    // Fall through to the compact, always-serializable result.
  }
  const compact = {
    schemaVersion: 1,
    ok: Boolean(value && typeof value === 'object' && 'ok' in value && value.ok === true),
    classification: classificationOf(value),
    truncated: true,
  };
  return { value: JSON.stringify(compact), truncated: true };
}

function printJson(value: unknown): void {
  process.stdout.write(`${serializeBoundedJson(value).value}\n`);
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  dependencies: MainDependencies = {},
): Promise<number> {
  try {
    const options = parseArguments(argv);
    const report = await runCandidateGates({ ...options, ...dependencies });
    printJson(report);
    return EXIT_CODES[report.classification];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const classification: ExitClassification = message === 'HELP' ? 'invalid-input' : 'invalid-input';
    printJson({ ok: false, classification, errors: [message] });
    return EXIT_CODES[classification];
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = await main();
}
