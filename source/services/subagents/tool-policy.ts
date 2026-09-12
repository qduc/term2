import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import type { ToolInvocationContext } from '../agent-runtime/tool-invocation-context.js';
import type { ILoggingService, ISettingsService, ISessionContextService } from '../service-interfaces.js';
import type { ExecutionContext } from '../execution-context.js';
import type { SubagentDefinition, SupportedSubagentRole, ValidationEvidence } from './types.js';
import type { AnyToolDefinition, CommandMessage, SchemaToolDefinition, ToolRegistry } from '../../tools/types.js';
import { isZodToolParameterSchema } from '../../tools/types.js';
import type { z, ZodTypeAny } from 'zod';
import { parse } from 'unbash';
import type { Word, WordPart } from 'unbash';
import { isPathInScopeSafe, isHostInScope } from '../agent-runtime/scope-resolver.js';
import { getProvider } from '../../providers/index.js';
import { wrapToolInvoke, wrapNeedsApproval } from '../../lib/tool-invoke.js';
import { toOpenAIStrictToolSchema } from '../../lib/openai-strict-tool-schema.js';
import { shouldUseStrictToolSchema, shouldPreferPatchEditingModel } from '../../lib/tool-selection-policy.js';
import { createReadFileToolDefinition } from '../../tools/file/read-file.js';
import { createGrepToolDefinition } from '../../tools/file/grep.js';
import { createFindFilesToolDefinition } from '../../tools/file/glob.js';
import {
  createReadCodeOutlineToolDefinition,
  createCodeContextSearchToolDefinition,
} from '../../tools/file/code-context.js';
import { createWebSearchToolDefinition } from '../../tools/web/web-search.js';
import { createWebFetchToolDefinition } from '../../tools/web/web-fetch.js';
import { createApplyPatchToolDefinition } from '../../tools/file/apply-patch.js';
import { extractPatchPaths } from '../../tools/file/upstream-apply-patch.js';
import { createSearchReplaceToolDefinition } from '../../tools/file/search-replace.js';
import { createCreateFileToolDefinition } from '../../tools/file/create-file.js';
import { createShellToolDefinition } from '../../tools/system/shell.js';
import { createActivateSkillToolDefinition } from '../../tools/agent/activate-skill.js';
import { createAskOrchestratorToolDefinition } from '../../tools/agent/ask-orchestrator.js';
import type { SkillsService } from '../skills/skills-service.js';
import { registerToolFormatters } from '../../tools/command-message-formatters.js';
import { trimToolOutput } from '../../utils/output/trim-tool-output.js';
import { injectRunBudgetWarning } from '../../utils/inject-warning-into-tool-output.js';
import { tryAcquireFileLock } from '../../tools/file/file-locks.js';
import { classifyCommand, SafetyStatus } from '../../utils/shell/command-safety/index.js';
import { evaluateShellAutoApprovalAdvisories } from '../approval/shell-auto-approval-evaluator.js';
import { shouldBypassToolApproval } from '../approval/shell-auto-approval-resolver.js';
import { extractWordText } from '../../utils/shell/command-safety/utils.js';
import type { ISubagentClient } from './subagent-client-types.js';
import type { ToolApprovalPolicyRegistry } from '../approval/tool-approval-policy-registry.js';
import { MemoryCapabilityBuilder } from '../memory/memory-capabilities.js';
import type { NestedToolCompatibilityState } from '../session/nested-tool-compatibility-state.js';

const MODEL_FACING_EDITOR_TOOLS = new Set(['apply_patch', 'search_replace', 'create_file']);

/** A mutable holder for the last validation evidence captured from a shell run. */
export interface ValidationCapture {
  value?: ValidationEvidence;
}

export type SubagentRunContext = {
  agentId: string;
  role: SupportedSubagentRole;
  task: string;
  filesChanged: string[];
  toolCounts: Record<string, number>;
  activeCommandMessages: Record<string, CommandMessage[]>;
  turnCount: number;
  maxTurns: number;
  /** Per-file line deltas for diffStat, captured from editor-tool writes. */
  diffDeltas?: Map<string, { added: number; deleted: number }>;
  /** Last validation-shaped shell command evidence. */
  lastValidation?: ValidationCapture;
};

export function getSubagentRunContext(context: unknown): SubagentRunContext | undefined {
  const candidate = (context as ToolInvocationContext<SubagentRunContext> | undefined)?.context;
  if (
    candidate &&
    typeof candidate === 'object' &&
    typeof candidate.agentId === 'string' &&
    Array.isArray(candidate.filesChanged)
  ) {
    return candidate;
  }
  return undefined;
}

export function formatRunningCommandMessages(
  definition: Pick<AnyToolDefinition, 'name' | 'formatCommandMessage'>,
  params: unknown,
): CommandMessage[] {
  const callId = `subagent-tool-${randomUUID()}`;
  const item = {
    id: callId,
    rawItem: {
      id: callId,
      callId,
      arguments: params,
      output: '',
    },
  };

  try {
    const messages = definition.formatCommandMessage(item, 0, new Map());
    if (messages.length > 0) {
      return messages.map((message, index) => ({
        ...message,
        id: `${callId}-${index}`,
        status: 'running',
        output: '',
        success: undefined,
        failureReason: undefined,
        toolName: message.toolName ?? definition.name,
        toolArgs: message.toolArgs ?? params,
      }));
    }
  } catch {
    // Fall back to the tool name if a formatter cannot handle an in-flight item.
  }

  return [
    {
      id: `${callId}-0`,
      sender: 'command',
      status: 'running',
      command: definition.name,
      output: '',
      toolName: definition.name,
      toolArgs: params,
    },
  ];
}

function rejectUnsandboxedSubagentShell(params: unknown): string | undefined {
  if (params && typeof params === 'object' && (params as Record<string, unknown>).sandbox === 'unsandboxed') {
    return 'Error: unsandboxed shell execution is not available to subagents. Report the need to the main agent.';
  }
  return undefined;
}

function getShellCommand(params: unknown): string {
  if (!params || typeof params !== 'object') return '';
  const command = (params as Record<string, unknown>).command;
  return typeof command === 'string' ? command : '';
}

/** Heuristic for validation-shaped shell commands (test/lint/typecheck/build/tsc). */
const VALIDATION_COMMAND_PATTERNS = [
  /\bnpm\s+run\s+(test|lint|typecheck|tsc|build|check)\b/i,
  /\bnpx\s+(vitest|jest|tsc|eslint|prettier)\b/i,
  /\bpnpm\s+(run\s+)?(test|lint|typecheck|tsc|build|check)\b/i,
  /\byarn\s+(test|lint|typecheck|tsc|build|check)\b/i,
  /\bvitest\b/i,
  /\bjest\b/i,
  /\btsc\b/i,
  /\beslint\b/i,
  /\bprettier\b/i,
  /\b(test|lint|typecheck|build)\s*$/i,
  /\bpnpm\s+test\b/i,
  /\bnpm\s+test\b/i,
];

function isValidationCommand(command: string): boolean {
  return VALIDATION_COMMAND_PATTERNS.some((re) => re.test(command));
}

const MAX_VALIDATION_EXCERPT = 2000;

/**
 * Parse the terminal status line emitted by the shell tool.
 *
 * This deliberately only considers the first line. The remaining output is
 * command-owned text and can mention exit codes (or claim success) without
 * being evidence of how the command terminated.
 */
function parseExitStatus(result: string): number | undefined {
  const terminalStatus = result.split(/\r?\n/, 1)[0]?.trim() ?? '';
  const exitMatch = terminalStatus.match(/^exit\s+(\d+)$/i);
  if (exitMatch) return parseInt(exitMatch[1], 10);
  return undefined;
}

function buildValidationEvidence(command: string, result: string): ValidationEvidence {
  const exitStatus = parseExitStatus(result) ?? 'unknown';
  const excerpt =
    result.length > MAX_VALIDATION_EXCERPT ? result.slice(-(MAX_VALIDATION_EXCERPT - 20)) + '\n...(truncated)' : result;
  return { command, exitStatus, outputExcerpt: excerpt };
}

/**
 * Compute a line-count delta for a file. Reads the file before and after a
 * write, then records net added/deleted. Best-effort: uses net line delta
 * rather than a full LCS diff to stay cheap and dependency-free. Returns null
 * when the file cannot be read.
 */
function computeLineDelta(
  resolvedPath: string,
  beforeContent: string | null,
): { added: number; deleted: number } | null {
  let afterContent: string | null;
  try {
    afterContent = fs.existsSync(resolvedPath) ? fs.readFileSync(resolvedPath, 'utf-8') : null;
  } catch {
    return null;
  }
  const beforeLines = beforeContent === null ? 0 : beforeContent.split('\n').length;
  const afterLines = afterContent === null ? 0 : afterContent.split('\n').length;
  const net = afterLines - beforeLines;
  return {
    added: Math.max(0, net),
    deleted: Math.max(0, -net),
  };
}

function readFileOrNull(resolvedPath: string): string | null {
  try {
    return fs.existsSync(resolvedPath) ? fs.readFileSync(resolvedPath, 'utf-8') : null;
  } catch {
    return null;
  }
}

const MAX_SHELL_EVIDENCE_BYTES = 64 * 1024;

type ShellRegularFileMetadata = {
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  ino: bigint;
};

type ShellFileSnapshot =
  | { kind: 'missing' }
  | { kind: 'unknown' }
  | { kind: 'nonregular' }
  | (ShellRegularFileMetadata & { kind: 'regular-stat' })
  | (ShellRegularFileMetadata & { kind: 'regular-bytes'; content: Buffer });

function regularFileMetadata(stats: fs.BigIntStats): ShellRegularFileMetadata {
  return {
    size: stats.size,
    mtimeNs: stats.mtimeNs,
    ctimeNs: stats.ctimeNs,
    ino: stats.ino,
  };
}

/**
 * Capture bounded, byte-preserving evidence for a shell target.
 *
 * lstat deliberately keeps symlink and other non-regular targets out of the
 * read path. O_NOFOLLOW/O_NONBLOCK closes the race between lstat and open and
 * prevents a FIFO from becoming a blocking evidence read. Large regular files
 * use metadata only, which is bounded but can conservatively miss a write that
 * preserves every recorded stat field; in that case no attribution claim is
 * made.
 */
function snapshotShellFile(resolvedPath: string): ShellFileSnapshot {
  let stats: fs.BigIntStats;
  try {
    stats = fs.lstatSync(resolvedPath, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT' || (error as NodeJS.ErrnoException)?.code === 'ENOTDIR') {
      return { kind: 'missing' };
    }
    return { kind: 'unknown' };
  }

  if (!stats.isFile()) return { kind: 'nonregular' };
  const metadata = regularFileMetadata(stats);
  if (stats.size > BigInt(MAX_SHELL_EVIDENCE_BYTES)) {
    return { kind: 'regular-stat', ...metadata };
  }

  let fd: number | undefined;
  try {
    fd = fs.openSync(
      resolvedPath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0),
    );
    const openedStats = fs.fstatSync(fd, { bigint: true });
    if (!openedStats.isFile()) return { kind: 'unknown' };
    const openedMetadata = regularFileMetadata(openedStats);
    if (openedStats.size > BigInt(MAX_SHELL_EVIDENCE_BYTES)) {
      return { kind: 'regular-stat', ...openedMetadata };
    }

    const buffer = Buffer.allocUnsafe(MAX_SHELL_EVIDENCE_BYTES + 1);
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_SHELL_EVIDENCE_BYTES || BigInt(bytesRead) !== openedStats.size) {
      return { kind: 'regular-stat', ...openedMetadata };
    }
    return { kind: 'regular-bytes', ...openedMetadata, content: buffer.subarray(0, bytesRead) };
  } catch {
    return { kind: 'unknown' };
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Evidence is advisory; a close failure must not turn a shell result
        // into an attribution failure or leak the worker lock.
      }
    }
  }
}

function sameRegularMetadata(before: ShellRegularFileMetadata, after: ShellRegularFileMetadata): boolean {
  return (
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs &&
    before.ino === after.ino
  );
}

function shellFileChanged(before: ShellFileSnapshot, resolvedPath: string): boolean {
  const after = snapshotShellFile(resolvedPath);
  if (
    before.kind === 'unknown' ||
    after.kind === 'unknown' ||
    before.kind === 'nonregular' ||
    after.kind === 'nonregular'
  ) {
    return false;
  }
  if (before.kind === 'missing' || after.kind === 'missing') return before.kind !== after.kind;
  if (before.kind === 'regular-bytes' && after.kind === 'regular-bytes') {
    return !before.content.equals(after.content);
  }
  return !sameRegularMetadata(before, after);
}

const SHELL_FILE_REDIRECTS = new Set(['>', '>>', '>|', '&>', '&>>', '<>', '>&']);

function hasDynamicShellWordPart(part: WordPart): boolean {
  if (
    part.type === 'SimpleExpansion' ||
    part.type === 'ParameterExpansion' ||
    part.type === 'CommandExpansion' ||
    part.type === 'ArithmeticExpansion' ||
    part.type === 'ProcessSubstitution' ||
    part.type === 'ExtendedGlob' ||
    part.type === 'BraceExpansion'
  ) {
    return true;
  }
  if (part.type === 'DoubleQuoted' || part.type === 'LocaleString') {
    return part.parts.some(hasDynamicShellWordPart);
  }
  return false;
}

function extractConcreteShellWord(word: Word | undefined): string | undefined {
  if (!word || word.parts?.some(hasDynamicShellWordPart)) return undefined;
  const value = extractWordText(word);
  if (!value || value === '~' || value.startsWith('~/')) return undefined;
  return value;
}

type ShellWriteTargetInspection = {
  paths: string[];
  hasUnresolvedWrite: boolean;
  parseUnknown: boolean;
};

/**
 * Inspect shell syntax for targets that can actually be written by a redirect
 * or tee. This is admission/locking evidence only; a path is added to
 * filesChanged only after the corresponding file is observed to change.
 */
function inspectShellWriteTargets(command: string, cwd: string): ShellWriteTargetInspection {
  const paths: string[] = [];
  let hasUnresolvedWrite = false;
  try {
    const ast = parse(command);
    if (ast.errors && ast.errors.length > 0) return { paths, hasUnresolvedWrite: false, parseUnknown: true };
    const visited = new Set<object>();

    const visit = (value: unknown): void => {
      if (!value || typeof value !== 'object') return;
      if (visited.has(value)) return;
      visited.add(value);
      if (Array.isArray(value)) {
        for (const item of value) visit(item);
        return;
      }

      const node = value as Record<string, unknown>;
      // unbash attaches redirects to the owning node: simple command redirects
      // live on Command, while redirects after a compound command live on the
      // wrapping Statement (and some compound nodes have their own property).
      // Inspect every actual redirects property rather than assuming Command.
      if ('redirects' in node) {
        const redirects = Array.isArray(node.redirects) ? node.redirects : [];
        if (!Array.isArray(node.redirects)) hasUnresolvedWrite = true;
        for (const redirectValue of redirects) {
          if (!redirectValue || typeof redirectValue !== 'object') {
            hasUnresolvedWrite = true;
            continue;
          }
          const redirect = redirectValue as Record<string, unknown>;
          const operator = redirect.operator;
          if (!SHELL_FILE_REDIRECTS.has(String(operator))) continue;
          const target = extractConcreteShellWord(
            redirect.target && typeof redirect.target === 'object' ? (redirect.target as Word) : undefined,
          );
          if (!target) {
            hasUnresolvedWrite = true;
          } else if (redirect.operator === '>&' && (/^\d+$/.test(target) || target === '-')) {
            // >&N and >&- duplicate or close a descriptor; neither writes a file.
          } else {
            paths.push(path.resolve(cwd, target));
          }
        }
      }

      if (node.type === 'Command') {
        const commandName = extractConcreteShellWord(node.name as Word | undefined);
        const commandBaseName = commandName ? path.posix.basename(commandName) : undefined;
        const suffix = Array.isArray(node.suffix) ? (node.suffix as Word[]) : [];
        let teeSuffix: Word[] | undefined = commandBaseName === 'tee' ? suffix : undefined;
        if (commandName === 'env') {
          // `env`'s utility is the first non-option, non-assignment word. Do
          // not search the whole suffix: `env printf tee out` runs printf and
          // must not attribute `out` as a tee target.
          let envIndex = 0;
          while (envIndex < suffix.length) {
            const value = extractConcreteShellWord(suffix[envIndex]);
            if (!value) break;
            if (value === '--') {
              envIndex += 1;
              break;
            }
            if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(value)) {
              envIndex += 1;
              continue;
            }
            if (value === '-i' || value === '-0' || value === '--ignore-environment' || value === '--null') {
              envIndex += 1;
              continue;
            }
            break;
          }
          if (extractConcreteShellWord(suffix[envIndex]) === 'tee') teeSuffix = suffix.slice(envIndex + 1);
        }
        if (teeSuffix) {
          let afterEndOfOptions = false;
          for (const word of teeSuffix) {
            const value = extractConcreteShellWord(word);
            if (!value) {
              hasUnresolvedWrite = true;
              continue;
            }
            if (!afterEndOfOptions && value === '--') {
              afterEndOfOptions = true;
              continue;
            }
            if (!afterEndOfOptions && value !== '-' && value.startsWith('-')) continue;
            paths.push(path.resolve(cwd, value));
          }
        }
      }

      for (const child of Object.values(node)) visit(child);
    };

    visit(ast);
  } catch {
    // Parsing is advisory evidence only. The shell policy still owns whether
    // an otherwise unsupported command may execute.
    return { paths: [...new Set(paths)], hasUnresolvedWrite: false, parseUnknown: true };
  }
  return { paths: [...new Set(paths)], hasUnresolvedWrite, parseUnknown: false };
}

export function captureValidationIfMatch(
  capture: ValidationCapture | undefined,
  command: string,
  result: unknown,
): void {
  if (!capture) return;
  if (!isValidationCommand(command)) return;
  const resultStr = typeof result === 'string' ? result : String(result ?? '');
  capture.value = buildValidationEvidence(command, resultStr);
}

export { isValidationCommand };

export class SubagentToolPolicy {
  #settings: ISettingsService;
  #logger: ILoggingService;
  #sessionContextService: ISessionContextService;
  #executionContext?: ExecutionContext;
  #agentClient?: ISubagentClient;

  constructor(deps: {
    settings: ISettingsService;
    logger: ILoggingService;
    sessionContextService: ISessionContextService;
    executionContext?: ExecutionContext;
    agentClient?: ISubagentClient;
  }) {
    this.#settings = deps.settings;
    this.#logger = deps.logger;
    this.#sessionContextService = deps.sessionContextService;
    this.#executionContext = deps.executionContext;
    this.#agentClient = deps.agentClient;
  }

  isWithinWriteBoundary(filePath: string, cwd: string): boolean {
    const boundaries = [cwd];
    const resolved = path.resolve(cwd, filePath);
    return boundaries.some((boundary) => {
      const resolvedBoundary = path.resolve(cwd, boundary);
      return resolved === resolvedBoundary || resolved.startsWith(resolvedBoundary + path.sep);
    });
  }

  tryAcquireWorkerWriteLocks(paths: string[], cwd: string): (() => void) | null {
    const uniqueResolvedPaths = [...new Set(paths.map((filePath) => path.resolve(cwd, filePath)))];
    const releases: Array<() => void> = [];

    for (const resolvedPath of uniqueResolvedPaths) {
      const release = tryAcquireFileLock(resolvedPath);
      if (!release) {
        for (const unlock of releases.reverse()) {
          unlock();
        }
        return null;
      }
      releases.push(release);
    }

    return () => {
      for (const unlock of releases.reverse()) {
        unlock();
      }
    };
  }

  extractPathsFromCommand(command: string, cwd: string): string[] {
    return inspectShellWriteTargets(command, cwd).paths;
  }

  private inspectShellWriteTargets(command: string, cwd: string): ShellWriteTargetInspection {
    return inspectShellWriteTargets(command, cwd);
  }

  extractSuccessfulWritePaths(result: unknown): string[] {
    if (typeof result !== 'string') return [];

    // New plain-text outputs: "Created <path>", "Overwrote <path>", "Updated <path>", "Deleted <path>".
    const successLines = result.split('\n').filter((line) => /^(Created|Overwrote|Updated|Deleted)\s+/.test(line));
    if (successLines.length > 0) {
      const paths = successLines.map((line) =>
        line
          .replace(/^(Created|Overwrote|Updated|Deleted)\s+/, '')
          .replace(/\s*\(new file\)\s*$/, '')
          .trim(),
      );
      return paths.filter((p) => p.length > 0);
    }

    // Legacy JSON outputs (kept for backward compatibility with old sessions/tests).
    try {
      const parsed: unknown = JSON.parse(result);
      const parsedRecord = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined;
      const output = parsedRecord?.output;
      if (Array.isArray(output)) {
        return output
          .filter(
            (item: unknown): item is { success: true; path: string } =>
              typeof item === 'object' &&
              item !== null &&
              (item as { success?: unknown }).success === true &&
              typeof (item as { path?: unknown }).path === 'string',
          )
          .map((item) => item.path);
      }
      if (parsedRecord?.success === true && typeof parsedRecord.path === 'string') {
        return [parsedRecord.path];
      }
    } catch {
      // Ignore JSON parse errors.
    }
    return [];
  }

  async isYellowCommandApproved(command: string, taskContext: string): Promise<boolean> {
    if (!this.#agentClient) return false;
    try {
      const advisories = await evaluateShellAutoApprovalAdvisories({
        commands: [{ id: '__subagent_worker_shell__', command }],
        history: taskContext
          ? [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: taskContext }] } as any]
          : [],
        settingsService: this.#settings,
        agentClient: this.#agentClient,
        logger: this.#logger,
        sessionContextService: this.#sessionContextService,
      });
      return advisories.get('__subagent_worker_shell__')?.approved === true;
    } catch (error: any) {
      this.#logger.warn('Worker shell YELLOW auto-approval evaluation failed', {
        error: error?.message || String(error),
      });
      return false;
    }
  }

  wrapShellTool<S extends ZodTypeAny>(
    definition: SchemaToolDefinition<S>,
    cwd: string,
    filesChanged: string[],
    taskContext: string,
    validationCapture?: ValidationCapture,
  ): SchemaToolDefinition<S> {
    const originalExecute = definition.execute.bind(definition);
    const originalNeedsApproval = definition.needsApproval.bind(definition);
    return {
      ...definition,
      needsApproval: () => false,
      execute: async (params: z.infer<S>, context?: unknown, details?: unknown) => {
        const unsandboxedError = rejectUnsandboxedSubagentShell(params);
        if (unsandboxedError) {
          return unsandboxedError;
        }

        const command = getShellCommand(params);
        if (!command) {
          return originalExecute(params, context, details);
        }

        // The shell definition owns sandbox-aware approval policy. When it says
        // no approval is needed, the sandbox is the safety boundary just as it
        // is for the root agent; do not re-block the command by classification.
        // Keep the worker's non-interactive fallback only when the underlying
        // shell actually requires approval (for example, without a sandbox).
        // In 'always' auto-approval mode that fallback is skipped entirely,
        // mirroring the root agent's unrestricted shell approval path.
        const autoApproveMode = this.#settings.get('shell.autoApproveMode');
        const bypassWorkspaceWriteBoundary = shouldBypassToolApproval(definition.name, autoApproveMode);
        const underlyingNeedsApproval =
          autoApproveMode !== 'always' && (await originalNeedsApproval(params, context)) === true;
        if (underlyingNeedsApproval) {
          const status = classifyCommand(command, this.#logger);
          if (status === SafetyStatus.RED) {
            return `Error: command blocked for safety (${status}). Workers cannot run commands that require interactive approval. Command: ${command}`;
          }
          if (status === SafetyStatus.YELLOW) {
            const approved = await this.isYellowCommandApproved(command, taskContext);
            if (!approved) {
              return `Error: command blocked for safety (${status}). Workers cannot run commands that require interactive approval. Command: ${command}`;
            }
          }
        }

        const { paths: extractedPaths, hasUnresolvedWrite } = this.inspectShellWriteTargets(command, cwd);
        if (hasUnresolvedWrite && underlyingNeedsApproval && !bypassWorkspaceWriteBoundary) {
          return `Error: command blocked — could not determine shell write targets safely outside the sandbox. Command: ${command}`;
        }
        if (extractedPaths.length > 0) {
          for (const filePath of extractedPaths) {
            if (!bypassWorkspaceWriteBoundary && !this.isWithinWriteBoundary(filePath, cwd)) {
              return `Error: command blocked — target path "${filePath}" is outside the allowed write boundary. Command: ${command}`;
            }
          }

          const releaseWorkerLocks = this.tryAcquireWorkerWriteLocks(extractedPaths, cwd);
          if (!releaseWorkerLocks) {
            return 'Error: command blocked — one or more target files are already being modified by another worker.';
          }

          let beforeSnapshots: Map<string, ShellFileSnapshot> | undefined;
          try {
            beforeSnapshots = new Map(extractedPaths.map((filePath) => [filePath, snapshotShellFile(filePath)]));
            const result = await originalExecute(params, context, details);
            captureValidationIfMatch(validationCapture, command, result);
            return result;
          } finally {
            try {
              if (beforeSnapshots) {
                filesChanged.push(
                  ...extractedPaths.filter((filePath) => shellFileChanged(beforeSnapshots!.get(filePath)!, filePath)),
                );
              }
            } finally {
              releaseWorkerLocks();
            }
          }
        }

        const result = await originalExecute(params, context, details);
        captureValidationIfMatch(validationCapture, command, result);
        return result;
      },
    };
  }

  wrapNestedShellTool<S extends ZodTypeAny>(definition: SchemaToolDefinition<S>, cwd: string): SchemaToolDefinition<S> {
    const originalExecute = definition.execute.bind(definition);
    const originalNeedsApproval = definition.needsApproval.bind(definition);
    return {
      ...definition,
      needsApproval: async (params: z.infer<S>, context?: unknown) =>
        this.#settings.get('shell.autoApproveMode') === 'always' ? false : await originalNeedsApproval(params, context),
      execute: async (params: z.infer<S>, context?: unknown, details?: unknown) => {
        const unsandboxedError = rejectUnsandboxedSubagentShell(params);
        if (unsandboxedError) {
          return unsandboxedError;
        }

        const command = getShellCommand(params);
        const { paths: extractedPaths, hasUnresolvedWrite } = command
          ? this.inspectShellWriteTargets(command, cwd)
          : ({ paths: [], hasUnresolvedWrite: false, parseUnknown: false } satisfies ShellWriteTargetInspection);
        const bypassWorkspaceWriteBoundary = shouldBypassToolApproval(
          definition.name,
          this.#settings.get('shell.autoApproveMode'),
        );
        const sandboxOwnsContainment = this.#settings.get('sandbox.enabled') !== false;
        if (hasUnresolvedWrite && !sandboxOwnsContainment && !bypassWorkspaceWriteBoundary) {
          return `Error: command blocked - could not determine shell write targets safely outside the sandbox. Command: ${command}`;
        }
        for (const filePath of extractedPaths) {
          if (!bypassWorkspaceWriteBoundary && !this.isWithinWriteBoundary(filePath, cwd)) {
            return `Error: command blocked - target path "${filePath}" is outside the allowed write boundary. Command: ${command}`;
          }
        }

        const releaseWorkerLocks =
          extractedPaths.length > 0 ? this.tryAcquireWorkerWriteLocks(extractedPaths, cwd) : () => {};
        if (!releaseWorkerLocks) {
          return 'Error: command blocked - one or more target files are already being modified by another worker.';
        }

        let beforeSnapshots: Map<string, ShellFileSnapshot> | undefined;
        try {
          beforeSnapshots = new Map(extractedPaths.map((filePath) => [filePath, snapshotShellFile(filePath)]));
          const result = await originalExecute(params, context, details);
          const ctx = getSubagentRunContext(context);
          if (ctx?.lastValidation) {
            captureValidationIfMatch(ctx.lastValidation, command, result);
          }
          return result;
        } finally {
          try {
            const ctx = getSubagentRunContext(context);
            if (beforeSnapshots) {
              ctx?.filesChanged.push(
                ...extractedPaths.filter((filePath) => shellFileChanged(beforeSnapshots!.get(filePath)!, filePath)),
              );
            }
          } finally {
            releaseWorkerLocks();
          }
        }
      },
    };
  }

  wrapReadOnlyShellTool<S extends ZodTypeAny>(definition: SchemaToolDefinition<S>): SchemaToolDefinition<S> {
    const originalExecute = definition.execute.bind(definition);
    const cwd = this.#executionContext?.getCwd() ?? process.cwd();
    return {
      ...definition,
      needsApproval: () => false,
      execute: async (params: z.infer<S>, context?: unknown, details?: unknown) => {
        const unsandboxedError = rejectUnsandboxedSubagentShell(params);
        if (unsandboxedError) {
          return unsandboxedError;
        }

        const command = getShellCommand(params);
        if (!command) {
          return originalExecute(params, context, details);
        }

        const status = classifyCommand(command, this.#logger);
        if (status !== SafetyStatus.GREEN) {
          return `Error: command blocked - explorer can only run read-only (GREEN) shell commands. Command: ${command}`;
        }

        const writeTargets = this.extractPathsFromCommand(command, cwd);
        if (writeTargets.length > 0) {
          return `Error: command blocked - explorer can only run read-only (GREEN) shell commands. Command: ${command}`;
        }

        return originalExecute(params, context, details);
      },
    };
  }

  wrapWriteTool<S extends ZodTypeAny>(
    definition: SchemaToolDefinition<S>,
    cwd: string,
    filesChanged: string[],
    extractPaths: (params: z.infer<S>) => string[],
    nestedApprovals = false,
    diffDeltas?: Map<string, { added: number; deleted: number }>,
  ): SchemaToolDefinition<S> {
    const originalExecute = definition.execute.bind(definition);
    const originalNeedsApproval = definition.needsApproval.bind(definition);

    return {
      ...definition,
      needsApproval: nestedApprovals
        ? async (params: z.infer<S>, context?: unknown) => {
            if (shouldBypassToolApproval(definition.name, this.#settings.get('shell.autoApproveMode'))) {
              return false;
            }
            const paths = extractPaths(params);
            if (paths.some((filePath) => !this.isWithinWriteBoundary(filePath, cwd))) {
              return false;
            }
            return originalNeedsApproval(params, context);
          }
        : () => false,
      execute: async (params: z.infer<S>, context?: unknown, details?: unknown) => {
        const paths = extractPaths(params);
        const bypassWorkspaceWriteBoundary = shouldBypassToolApproval(
          definition.name,
          this.#settings.get('shell.autoApproveMode'),
        );

        for (const filePath of paths) {
          if (!bypassWorkspaceWriteBoundary && !this.isWithinWriteBoundary(filePath, cwd)) {
            return `Error: Write rejected: path "${filePath}" is outside the allowed write boundary.`;
          }
        }

        const releaseWorkerLocks = this.tryAcquireWorkerWriteLocks(paths, cwd);
        if (!releaseWorkerLocks) {
          return 'Error: Write rejected: one or more target files are already being modified by another worker.';
        }

        // Snapshot before-write content for diffStat capture.
        const beforeSnapshots = new Map<string, string | null>();
        for (const filePath of paths) {
          const resolved = path.resolve(cwd, filePath);
          beforeSnapshots.set(resolved, readFileOrNull(resolved));
        }

        try {
          const result = await originalExecute(params, context, details);
          for (const successfulPath of this.extractSuccessfulWritePaths(result)) {
            const resolvedPath = path.resolve(cwd, successfulPath);
            if (nestedApprovals) {
              getSubagentRunContext(context)?.filesChanged.push(successfulPath);
              const ctx = getSubagentRunContext(context);
              if (ctx?.diffDeltas) {
                const delta = computeLineDelta(resolvedPath, beforeSnapshots.get(resolvedPath) ?? null);
                if (delta) ctx.diffDeltas.set(resolvedPath, delta);
              }
            } else {
              filesChanged.push(successfulPath);
              if (diffDeltas) {
                const delta = computeLineDelta(resolvedPath, beforeSnapshots.get(resolvedPath) ?? null);
                if (delta) diffDeltas.set(resolvedPath, delta);
              }
            }
          }
          return result;
        } finally {
          releaseWorkerLocks();
        }
      },
    };
  }

  /**
   * Wrap a read tool with filesystem scope enforcement.
   * When `scopePatterns` is defined (non-undefined), every path read must
   * match at least one pattern. Undefined scope = no restriction.
   * Uses symlink-safe realpath resolution.
   */
  wrapReadToolWithScope<S extends ZodTypeAny>(
    definition: SchemaToolDefinition<S>,
    scopePatterns: string[] | undefined,
    extractPath: (params: z.infer<S>) => string | undefined,
  ): SchemaToolDefinition<S> {
    // No scope defined — no fine-grained restriction
    if (scopePatterns === undefined) return definition;

    const originalExecute = definition.execute.bind(definition);
    return {
      ...definition,
      execute: async (params: z.infer<S>, context?: unknown, details?: unknown) => {
        const filePath = extractPath(params);
        if (filePath) {
          const safe = await isPathInScopeSafe(filePath, scopePatterns);
          if (!safe) {
            return `Error: Path "${filePath}" is outside the allowed filesystem read scope.`;
          }
        }
        return originalExecute(params, context, details);
      },
    };
  }

  /**
   * Wrap a write tool with filesystem scope enforcement.
   * When `scopePatterns` is defined (non-undefined), every path written must
   * match at least one pattern. Undefined scope = no restriction.
   * Uses symlink-safe realpath resolution: resolves existing paths with
   * realpath, and for nonexistent targets resolves the nearest existing
   * ancestor to detect symlink escapes.
   */
  wrapWriteToolWithScope<S extends ZodTypeAny>(
    definition: SchemaToolDefinition<S>,
    scopePatterns: string[] | undefined,
    extractPaths: (params: z.infer<S>) => string[],
  ): SchemaToolDefinition<S> {
    if (scopePatterns === undefined) return definition;

    const originalExecute = definition.execute.bind(definition);
    return {
      ...definition,
      execute: async (params: z.infer<S>, context?: unknown, details?: unknown) => {
        const paths = extractPaths(params);
        for (const filePath of paths) {
          const safe = await isPathInScopeSafe(filePath, scopePatterns);
          if (!safe) {
            return `Error: Path "${filePath}" is outside the allowed filesystem write scope.`;
          }
        }
        return originalExecute(params, context, details);
      },
    };
  }

  /**
   * Wrap a shell tool with filesystem scope enforcement.
   *
   * Shell commands cannot be safely scoped to a subset of the filesystem
   * because any command can access the entire workspace through symlinks,
   * absolute paths, environment variables, and other means. When any
   * finite filesystem scope is defined, the shell tool is rejected with
   * a typed permission error.
   */
  wrapShellToolWithScope<S extends ZodTypeAny>(
    definition: SchemaToolDefinition<S>,
    scopePatterns: string[] | undefined,
  ): SchemaToolDefinition<S> {
    if (scopePatterns !== undefined) {
      return {
        ...definition,
        execute: async () =>
          'Error: Shell access is not permitted when filesystem scopes are configured. ' +
          'Filesystem scopes cannot safely restrict shell commands because the shell ' +
          'can bypass path-based restrictions through symlinks, absolute paths, ' +
          'environment variables, and arbitrary command execution. ' +
          'Remove filesystem scopes to use shell, or use scoped read/write tools instead.',
      };
    }
    return definition;
  }

  /**
   * Wrap a network tool (web_search, web_fetch) with host scope enforcement.
   * When `hostPatterns` is defined (non-undefined), the target URL must
   * match at least one allowed host. Empty array = no network authority.
   * Undefined = no restriction (legacy coarse behavior).
   *
   * web_search has no target host — it searches broadly. To allow
   * web_search under host scopes, the scope must contain the literal
   * wildcard `'*'` (meaning "all hosts").
   *
   * web_fetch validates the initial URL host including case and port,
   * but the underlying HTTP library may follow redirects transparently to
   * a different host. Because redirect targets are not observable or
   * enforceable by the current fetch tool, web_fetch is REJECTED at
   * definition time when host scopes are set to anything other than
   * `['*']` (all hosts). The caller receives a typed permission error.
   */
  wrapNetworkToolWithScope<S extends ZodTypeAny>(
    definition: SchemaToolDefinition<S>,
    hostPatterns: string[] | undefined,
    extractUrl: (params: z.infer<S>) => string | undefined,
  ): SchemaToolDefinition<S> {
    if (hostPatterns === undefined) return definition;

    // Empty host patterns = explicitly no network authority
    if (hostPatterns.length === 0) {
      return {
        ...definition,
        execute: async () => `Error: Network access denied: no allowed hosts configured.`,
      };
    }

    // ── Redirect safety guard for fetch-style tools ──
    // If the tool follows redirects and we can't observe them, reject
    // any finite host scope that isn't the wildcard '*'.
    if (definition.name === 'web_fetch' && hostPatterns.length > 0 && !hostPatterns.includes('*')) {
      return {
        ...definition,
        execute: async () =>
          `Error: Permission denied: web_fetch cannot be used with finite host scopes ` +
          `because the underlying HTTP library may follow redirects transparently ` +
          `to hosts outside the allowed scope. To allow web_fetch under network ` +
          `restrictions, use hosts: ['*'] (all hosts). Otherwise, remove ` +
          `web_fetch from the tool set or omit network host scopes entirely.`,
      };
    }

    const originalExecute = definition.execute.bind(definition);
    return {
      ...definition,
      execute: async (params: z.infer<S>, context?: unknown, details?: unknown) => {
        const url = extractUrl(params);
        if (url) {
          // Host-specific validation: check the exact URL host
          if (!isHostInScope(url, hostPatterns)) {
            return `Error: Host "${url}" is not in the allowed network hosts.`;
          }
        } else {
          // No extractable URL (e.g., web_search with only a query).
          // This tool has no target host; it requires the wildcard scope.
          if (!hostPatterns.includes('*')) {
            return (
              `Error: Network access denied: the "${definition.name}" tool has no target host ` +
              `and requires the '*' wildcard host scope to operate under network restrictions.`
            );
          }
        }
        return originalExecute(params, context, details);
      },
    };
  }
}

export class SubagentToolFactory {
  #settings: ISettingsService;
  #logger: ILoggingService;
  #executionContext?: ExecutionContext;
  #toolPolicy: SubagentToolPolicy;
  #skillsService?: SkillsService;
  #memoryCapabilities: MemoryCapabilityBuilder;
  #nestedCompatibility?: NestedToolCompatibilityState;
  #readOnly: boolean;

  constructor(deps: {
    settings: ISettingsService;
    logger: ILoggingService;
    executionContext?: ExecutionContext;
    toolPolicy: SubagentToolPolicy;
    skillsService?: SkillsService;
    nestedCompatibility?: NestedToolCompatibilityState;
    readOnly?: boolean;
  }) {
    this.#settings = deps.settings;
    this.#logger = deps.logger;
    this.#executionContext = deps.executionContext;
    this.#toolPolicy = deps.toolPolicy;
    this.#skillsService = deps.skillsService;
    this.#nestedCompatibility = deps.nestedCompatibility;
    this.#readOnly = deps.readOnly ?? false;
    this.#memoryCapabilities = new MemoryCapabilityBuilder(deps.settings);
  }

  buildToolDefinitions(
    definition: SubagentDefinition,
    filesChanged: string[],
    taskContext: string,
    searchViaShell: boolean,
    nestedApprovals = false,
    diffDeltas?: Map<string, { added: number; deleted: number }>,
    validationCapture?: ValidationCapture,
    askOrchestrator?: (question: string) => Promise<string>,
    options?: { executionContext?: ExecutionContext },
  ): AnyToolDefinition[] {
    const tools: AnyToolDefinition[] = [];
    const executionContext = options?.executionContext ?? this.#executionContext;
    const cwd = executionContext?.getCwd() ?? process.cwd();
    const isRemote = executionContext?.isRemote() ?? false;

    // Mentor is advisory-only; it must never inherit incidental capabilities.
    if (definition.role === 'mentor') return tools;

    // This callback is supplied exclusively by the async execution-segment
    // adapter. Sync and nested runners never receive it.
    if (askOrchestrator && ['explorer', 'worker', 'librarian'].includes(definition.role)) {
      tools.push(createAskOrchestratorToolDefinition(askOrchestrator));
    }

    if (this.#skillsService && this.#skillsService.getAvailableSkillsForModel().length > 0) {
      tools.push(createActivateSkillToolDefinition(this.#skillsService));
    }

    tools.push(
      ...this.#memoryCapabilities.build({ kind: 'subagent', role: definition.role }, { projectPath: cwd }).tools,
    );

    // Extract resolved scopes from definition
    const fsReadScope = definition.filesystemScope?.read;
    const fsWriteScope = definition.filesystemScope?.write;
    const netScope = definition.networkScope;
    // Shell-based search is preferred for roles that can use it, but explorer
    // shell access is restricted to GREEN commands. Keep dedicated read tools
    // available to read-only explorers as a safe fallback when shell search is
    // blocked. Keep descriptions consistent so the model does not call an
    // unregistered tool.
    const readOnlyExplorerSearchFallback = definition.role === 'explorer' && definition.canRead && !definition.canWrite;
    const dedicatedSearchAvailable = !searchViaShell || readOnlyExplorerSearchFallback;
    const globAvailable = definition.canRead && dedicatedSearchAvailable;

    if (definition.canRead) {
      tools.push(
        this.#toolPolicy.wrapReadToolWithScope(
          createReadFileToolDefinition({
            executionContext,
            allowOutsideWorkspace: false,
            nestedCompatibility: this.#nestedCompatibility,
          }),
          fsReadScope,
          (params) => params.path,
        ),
      );

      if (dedicatedSearchAvailable) {
        tools.push(
          this.#toolPolicy.wrapReadToolWithScope(
            createGrepToolDefinition({
              executionContext,
              globAvailable,
              nestedCompatibility: this.#nestedCompatibility,
            }),
            fsReadScope,
            (params) => params.path,
          ),
          this.#toolPolicy.wrapReadToolWithScope(
            createFindFilesToolDefinition({
              executionContext,
              nestedCompatibility: this.#nestedCompatibility,
            }),
            fsReadScope,
            (params) =>
              // When path is omitted, the tool defaults to searching from the
              // workspace root (CWD). Use the workspace root as the base path
              // for scope validation. Never treat the glob pattern as a path.
              params.path ?? '.',
          ),
        );
      }

      if (!isRemote) {
        tools.push(
          this.#toolPolicy.wrapReadToolWithScope(
            createReadCodeOutlineToolDefinition({ executionContext }),
            fsReadScope,
            (params) => params.path,
          ),
          this.#toolPolicy.wrapReadToolWithScope(
            createCodeContextSearchToolDefinition({ executionContext, globAvailable }),
            fsReadScope,
            (params) => params.path,
          ),
        );
      }
    }

    if (definition.canSearchWeb) {
      tools.push(
        this.#toolPolicy.wrapNetworkToolWithScope(
          createWebSearchToolDefinition({ settingsService: this.#settings, loggingService: this.#logger }),
          netScope,
          () => undefined,
        ),
        this.#toolPolicy.wrapNetworkToolWithScope(
          createWebFetchToolDefinition({ settingsService: this.#settings, loggingService: this.#logger }),
          netScope,
          (params) => params.url,
        ),
      );
    }

    if (definition.canRunShell) {
      const shellDef = this.#toolPolicy.wrapShellToolWithScope(
        createShellToolDefinition({
          settingsService: this.#settings,
          loggingService: this.#logger,
          executionContext,
          searchViaShell,
          nestedCompatibility: this.#nestedCompatibility,
        }),
        fsReadScope,
      );

      if (definition.canWrite && !this.#readOnly) {
        tools.push(
          nestedApprovals
            ? this.#toolPolicy.wrapNestedShellTool(shellDef, cwd)
            : this.#toolPolicy.wrapShellTool(shellDef, cwd, filesChanged, taskContext, validationCapture),
        );
      } else {
        tools.push(this.#toolPolicy.wrapReadOnlyShellTool(shellDef));
      }
    }

    if (definition.canWrite && !this.#readOnly) {
      const isGpt5 = shouldPreferPatchEditingModel(definition.model);
      if (isGpt5) {
        tools.push(
          this.#toolPolicy.wrapWriteToolWithScope(
            this.#toolPolicy.wrapWriteTool(
              createApplyPatchToolDefinition({
                settingsService: this.#settings,
                loggingService: this.#logger,
                executionContext,
              }),
              cwd,
              filesChanged,
              (params) => extractPatchPaths(params.patch),
              nestedApprovals,
              diffDeltas,
            ),
            fsWriteScope,
            (params) => extractPatchPaths(params.patch),
          ),
        );
      } else {
        tools.push(
          this.#toolPolicy.wrapWriteToolWithScope(
            this.#toolPolicy.wrapWriteTool(
              createSearchReplaceToolDefinition({
                settingsService: this.#settings,
                loggingService: this.#logger,
                executionContext,
              }),
              cwd,
              filesChanged,
              (params) => (params.path ? [params.path] : []),
              nestedApprovals,
              diffDeltas,
            ),
            fsWriteScope,
            (params) => (params.path ? [params.path] : []),
          ),
          this.#toolPolicy.wrapWriteToolWithScope(
            this.#toolPolicy.wrapWriteTool(
              createCreateFileToolDefinition({
                settingsService: this.#settings,
                loggingService: this.#logger,
                executionContext,
              }),
              cwd,
              filesChanged,
              (params) => (params.path ? [params.path] : []),
              nestedApprovals,
              diffDeltas,
            ),
            fsWriteScope,
            (params) => (params.path ? [params.path] : []),
          ),
        );
      }
    }

    registerToolFormatters(tools);

    // Honor explicit tool allowlist from the definition.
    // When a non-empty allowlist is present, only provision tools
    // whose names appear in it. This lets AgentRuntime pass resolved
    // tool lists through to ExecutionSubagentRunner.
    if (definition.tools && definition.tools.length > 0) {
      const allowed = new Set(definition.tools);
      // The three editor names represent one capability, while models expose
      // different concrete editing interfaces. An explicit request for any
      // editor therefore admits the compatible editor set selected above,
      // rather than requiring the requested spelling to match it exactly.
      // `canWrite` remains the sole authority grant for editor tools.
      const editorRequested = definition.canWrite && [...allowed].some((name) => MODEL_FACING_EDITOR_TOOLS.has(name));
      return tools.filter((tool) => {
        if (tool.name === 'activate_skill' || tool.name === 'ask_orchestrator') {
          return true;
        }
        return MODEL_FACING_EDITOR_TOOLS.has(tool.name) ? editorRequested : allowed.has(tool.name);
      });
    }

    return tools;
  }

  buildAgentTools(
    toolDefinitions: ToolRegistry,
    options: {
      providerId: string;
      /**
       * Graph-owned policy authority for this subagent run. When supplied,
       * wrapped tool policies register here so the subagent session resolves
       * interruptions against its own graph instead of an empty registry.
       */
      approvalPolicyRegistry?: ToolApprovalPolicyRegistry;
      onToolStart?: (
        toolName: string,
        params: unknown,
        commandMessages: CommandMessage[],
        context?: unknown,
        details?: unknown,
      ) => void;
      onToolComplete?: (toolName: string, result: unknown, context?: unknown, details?: unknown) => void;
    },
  ): ToolRegistry {
    const providerDef = getProvider(options.providerId);
    const capabilities = {
      supportsConversationChaining: providerDef?.capabilities?.supportsConversationChaining ?? false,
      usesStrictToolSchema: providerDef?.capabilities?.usesStrictToolSchema,
    };
    const useStrictSchema = shouldUseStrictToolSchema({
      providerId: options.providerId,
      capabilities,
    });

    return toolDefinitions.map((definition) => {
      const canonicalParameters =
        definition.canonicalParameters ??
        (isZodToolParameterSchema(definition.parameters) ? definition.parameters : undefined);
      const wrapped: AnyToolDefinition = {
        ...definition,
        canonicalParameters,
        parameters:
          useStrictSchema && isZodToolParameterSchema(definition.parameters)
            ? toOpenAIStrictToolSchema(definition.parameters)
            : definition.parameters,
        needsApproval: wrapNeedsApproval(definition, {
          bypassApproval: () => shouldBypassToolApproval(definition.name, this.#settings.get('shell.autoApproveMode')),
          registry: options.approvalPolicyRegistry,
        }),
        execute: async (params, context, details) => {
          options.onToolStart?.(
            definition.name,
            params,
            formatRunningCommandMessages(definition, params),
            context,
            details,
          );
          const maxOutputLength = this.#settings.get('shell.maxOutputChars');
          let result: unknown;
          try {
            result = await definition.execute(params, context, details);
          } finally {
            // Must pair with every onToolStart, including the throwing path: this
            // callback closes the active-tool gate that defers steering interrupts.
            options.onToolComplete?.(definition.name, result, context, details);
          }
          if (definition.preserveSerializedOutput) {
            return String(result ?? '');
          }
          const trimmedResult = trimToolOutput(result, undefined, maxOutputLength ?? undefined);
          // Structured content-part results (read_file images) carry no single
          // text slot for the run-budget advisory; deliver them unmodified so
          // the image reaches the provider converter.
          return typeof trimmedResult === 'string' ? injectRunBudgetWarning(trimmedResult, context) : trimmedResult;
        },
      };
      return wrapToolInvoke(
        wrapped,
        isZodToolParameterSchema(definition.parameters) ? definition.parameters : undefined,
        { argumentParsing: definition.argumentParsing },
      );
    });
  }
}
