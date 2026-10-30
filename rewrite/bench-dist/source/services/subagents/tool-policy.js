import { healPatchOperation } from '../../tools/file/patch-healing.js';
import { healSearchReplaceParams } from '../../tools/file/edit-healing.js';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { isZodToolParameterSchema } from '../../tools/types.js';
import { parse } from 'unbash';
import { isPathInScopeSafe, isHostInScope } from '../agent-runtime/scope-resolver.js';
import { getProvider } from '../../providers/index.js';
import { wrapToolInvoke, wrapNeedsApproval } from '../../lib/tool-invoke.js';
import { toOpenAIStrictToolSchema } from '../../lib/openai-strict-tool-schema.js';
import { shouldUseStrictToolSchema, shouldPreferPatchEditingModel } from '../../lib/tool-selection-policy.js';
import { createReadFileToolDefinition } from '../../tools/file/read-file.js';
import { createGrepToolDefinition } from '../../tools/file/grep.js';
import { createFindFilesToolDefinition } from '../../tools/file/glob.js';
import { createReadCodeOutlineToolDefinition, createCodeContextSearchToolDefinition, } from '../../tools/file/code-context.js';
import { createSelectedActivateSkillTool, createWebToolDefinitions, } from '../assembly/feature-selection.js';
import { createApplyPatchToolDefinition } from '../../tools/file/apply-patch.js';
import { extractPatchPaths } from '../../tools/file/upstream-apply-patch.js';
import { createSearchReplaceToolDefinition } from '../../tools/file/search-replace.js';
import { createCreateFileToolDefinition } from '../../tools/file/create-file.js';
import { createShellToolDefinition } from '../../tools/system/shell.js';
import { createAskOrchestratorToolDefinition } from '../../tools/agent/ask-orchestrator.js';
import { createRunExplorerToolDefinition } from '../../tools/agent/run-explorer.js';
import { registerToolFormatters } from '../../tools/command-message-formatters.js';
import { trimToolOutput } from '../../utils/output/trim-tool-output.js';
import { injectRunBudgetWarning } from '../../utils/inject-warning-into-tool-output.js';
import { tryAcquireFileLock } from '../../tools/file/file-locks.js';
import { classifyCommand, SafetyStatus } from '../../utils/shell/command-safety/index.js';
import { evaluateShellAutoApprovalAdvisories } from '../approval/shell-auto-approval-evaluator.js';
import { shouldBypassToolApproval } from '../approval/shell-auto-approval-resolver.js';
import { extractWordText } from '../../utils/shell/command-safety/utils.js';
import { MemoryCapabilityBuilder } from '../memory/memory-capabilities.js';
import { createSessionBrowserToolDefinitions } from '../../tools/session-browser/session-browser-tools.js';
const MODEL_FACING_EDITOR_TOOLS = new Set(['apply_patch', 'search_replace', 'create_file']);
export function getSubagentRunContext(context) {
    const candidate = context?.context;
    if (candidate &&
        typeof candidate === 'object' &&
        typeof candidate.agentId === 'string' &&
        Array.isArray(candidate.filesChanged)) {
        return candidate;
    }
    return undefined;
}
function formatRunningCommandMessages(definition, params) {
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
    }
    catch {
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
function rejectUnsandboxedSubagentShell(params) {
    if (params && typeof params === 'object' && params.sandbox === 'unsandboxed') {
        return 'Error: unsandboxed shell execution is not available to subagents. Report the need to the main agent.';
    }
    return undefined;
}
function getShellCommand(params) {
    if (!params || typeof params !== 'object')
        return '';
    const command = params.command;
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
function isValidationCommand(command) {
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
function parseExitStatus(result) {
    const terminalStatus = result.split(/\r?\n/, 1)[0]?.trim() ?? '';
    const exitMatch = terminalStatus.match(/^exit\s+(\d+)$/i);
    if (exitMatch)
        return parseInt(exitMatch[1], 10);
    return undefined;
}
function buildValidationEvidence(command, result) {
    const exitStatus = parseExitStatus(result) ?? 'unknown';
    const excerpt = result.length > MAX_VALIDATION_EXCERPT ? result.slice(-(MAX_VALIDATION_EXCERPT - 20)) + '\n...(truncated)' : result;
    return { command, exitStatus, outputExcerpt: excerpt };
}
/**
 * Compute a line-count delta for a file. Reads the file before and after a
 * write, then records net added/deleted. Best-effort: uses net line delta
 * rather than a full LCS diff to stay cheap and dependency-free. Returns null
 * when the file cannot be read.
 */
function computeLineDelta(resolvedPath, beforeContent) {
    let afterContent;
    try {
        afterContent = fs.existsSync(resolvedPath) ? fs.readFileSync(resolvedPath, 'utf-8') : null;
    }
    catch {
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
function readFileOrNull(resolvedPath) {
    try {
        return fs.existsSync(resolvedPath) ? fs.readFileSync(resolvedPath, 'utf-8') : null;
    }
    catch {
        return null;
    }
}
const MAX_SHELL_EVIDENCE_BYTES = 64 * 1024;
function regularFileMetadata(stats) {
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
function snapshotShellFile(resolvedPath) {
    let stats;
    try {
        stats = fs.lstatSync(resolvedPath, { bigint: true });
    }
    catch (error) {
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
            return { kind: 'missing' };
        }
        return { kind: 'unknown' };
    }
    if (!stats.isFile())
        return { kind: 'nonregular' };
    const metadata = regularFileMetadata(stats);
    if (stats.size > BigInt(MAX_SHELL_EVIDENCE_BYTES)) {
        return { kind: 'regular-stat', ...metadata };
    }
    let fd;
    try {
        fd = fs.openSync(resolvedPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
        const openedStats = fs.fstatSync(fd, { bigint: true });
        if (!openedStats.isFile())
            return { kind: 'unknown' };
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
    }
    catch {
        return { kind: 'unknown' };
    }
    finally {
        if (fd !== undefined) {
            try {
                fs.closeSync(fd);
            }
            catch {
                // Evidence is advisory; a close failure must not turn a shell result
                // into an attribution failure or leak the worker lock.
            }
        }
    }
}
function sameRegularMetadata(before, after) {
    return (before.size === after.size &&
        before.mtimeNs === after.mtimeNs &&
        before.ctimeNs === after.ctimeNs &&
        before.ino === after.ino);
}
function shellFileChanged(before, resolvedPath) {
    const after = snapshotShellFile(resolvedPath);
    if (before.kind === 'unknown' ||
        after.kind === 'unknown' ||
        before.kind === 'nonregular' ||
        after.kind === 'nonregular') {
        return false;
    }
    if (before.kind === 'missing' || after.kind === 'missing')
        return before.kind !== after.kind;
    if (before.kind === 'regular-bytes' && after.kind === 'regular-bytes') {
        return !before.content.equals(after.content);
    }
    return !sameRegularMetadata(before, after);
}
const SHELL_FILE_REDIRECTS = new Set(['>', '>>', '>|', '&>', '&>>', '<>', '>&']);
function hasDynamicShellWordPart(part) {
    if (part.type === 'SimpleExpansion' ||
        part.type === 'ParameterExpansion' ||
        part.type === 'CommandExpansion' ||
        part.type === 'ArithmeticExpansion' ||
        part.type === 'ProcessSubstitution' ||
        part.type === 'ExtendedGlob' ||
        part.type === 'BraceExpansion') {
        return true;
    }
    if (part.type === 'DoubleQuoted' || part.type === 'LocaleString') {
        return part.parts.some(hasDynamicShellWordPart);
    }
    return false;
}
function extractConcreteShellWord(word) {
    if (!word || word.parts?.some(hasDynamicShellWordPart))
        return undefined;
    const value = extractWordText(word);
    if (!value || value === '~' || value.startsWith('~/'))
        return undefined;
    return value;
}
/**
 * Inspect shell syntax for targets that can actually be written by a redirect
 * or tee. This is admission/locking evidence only; a path is added to
 * filesChanged only after the corresponding file is observed to change.
 */
function inspectShellWriteTargets(command, cwd) {
    const paths = [];
    let hasUnresolvedWrite = false;
    try {
        const ast = parse(command);
        if (ast.errors && ast.errors.length > 0)
            return { paths, hasUnresolvedWrite: false, parseUnknown: true };
        const visited = new Set();
        const visit = (value) => {
            if (!value || typeof value !== 'object')
                return;
            if (visited.has(value))
                return;
            visited.add(value);
            if (Array.isArray(value)) {
                for (const item of value)
                    visit(item);
                return;
            }
            const node = value;
            // unbash attaches redirects to the owning node: simple command redirects
            // live on Command, while redirects after a compound command live on the
            // wrapping Statement (and some compound nodes have their own property).
            // Inspect every actual redirects property rather than assuming Command.
            if ('redirects' in node) {
                const redirects = Array.isArray(node.redirects) ? node.redirects : [];
                if (!Array.isArray(node.redirects))
                    hasUnresolvedWrite = true;
                for (const redirectValue of redirects) {
                    if (!redirectValue || typeof redirectValue !== 'object') {
                        hasUnresolvedWrite = true;
                        continue;
                    }
                    const redirect = redirectValue;
                    const operator = redirect.operator;
                    if (!SHELL_FILE_REDIRECTS.has(String(operator)))
                        continue;
                    const target = extractConcreteShellWord(redirect.target && typeof redirect.target === 'object' ? redirect.target : undefined);
                    if (!target) {
                        hasUnresolvedWrite = true;
                    }
                    else if (redirect.operator === '>&' && (/^\d+$/.test(target) || target === '-')) {
                        // >&N and >&- duplicate or close a descriptor; neither writes a file.
                    }
                    else {
                        paths.push(path.resolve(cwd, target));
                    }
                }
            }
            if (node.type === 'Command') {
                const commandName = extractConcreteShellWord(node.name);
                const commandBaseName = commandName ? path.posix.basename(commandName) : undefined;
                const suffix = Array.isArray(node.suffix) ? node.suffix : [];
                let teeSuffix = commandBaseName === 'tee' ? suffix : undefined;
                if (commandName === 'env') {
                    // `env`'s utility is the first non-option, non-assignment word. Do
                    // not search the whole suffix: `env printf tee out` runs printf and
                    // must not attribute `out` as a tee target.
                    let envIndex = 0;
                    while (envIndex < suffix.length) {
                        const value = extractConcreteShellWord(suffix[envIndex]);
                        if (!value)
                            break;
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
                    if (extractConcreteShellWord(suffix[envIndex]) === 'tee')
                        teeSuffix = suffix.slice(envIndex + 1);
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
                        if (!afterEndOfOptions && value !== '-' && value.startsWith('-'))
                            continue;
                        paths.push(path.resolve(cwd, value));
                    }
                }
            }
            for (const child of Object.values(node))
                visit(child);
        };
        visit(ast);
    }
    catch {
        // Parsing is advisory evidence only. The shell policy still owns whether
        // an otherwise unsupported command may execute.
        return { paths: [...new Set(paths)], hasUnresolvedWrite: false, parseUnknown: true };
    }
    return { paths: [...new Set(paths)], hasUnresolvedWrite, parseUnknown: false };
}
export function captureValidationIfMatch(capture, command, result) {
    if (!capture)
        return;
    if (!isValidationCommand(command))
        return;
    const resultStr = typeof result === 'string' ? result : String(result ?? '');
    capture.value = buildValidationEvidence(command, resultStr);
}
export { isValidationCommand };
export class SubagentToolPolicy {
    #settings;
    #logger;
    #sessionContextService;
    #executionContext;
    #agentClient;
    constructor(deps) {
        this.#settings = deps.settings;
        this.#logger = deps.logger;
        this.#sessionContextService = deps.sessionContextService;
        this.#executionContext = deps.executionContext;
        this.#agentClient = deps.agentClient;
    }
    isWithinWriteBoundary(filePath, cwd) {
        const boundaries = [cwd];
        const resolved = path.resolve(cwd, filePath);
        return boundaries.some((boundary) => {
            const resolvedBoundary = path.resolve(cwd, boundary);
            return resolved === resolvedBoundary || resolved.startsWith(resolvedBoundary + path.sep);
        });
    }
    tryAcquireWorkerWriteLocks(paths, cwd) {
        const uniqueResolvedPaths = [...new Set(paths.map((filePath) => path.resolve(cwd, filePath)))];
        const releases = [];
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
    extractPathsFromCommand(command, cwd) {
        return inspectShellWriteTargets(command, cwd).paths;
    }
    inspectShellWriteTargets(command, cwd) {
        return inspectShellWriteTargets(command, cwd);
    }
    extractSuccessfulWritePaths(result) {
        if (typeof result !== 'string')
            return [];
        // New plain-text outputs: "Created <path>", "Overwrote <path>", "Updated <path>", "Deleted <path>".
        const successLines = result.split('\n').filter((line) => /^(Created|Overwrote|Updated|Deleted)\s+/.test(line));
        if (successLines.length > 0) {
            const paths = successLines.map((line) => line
                .replace(/^(Created|Overwrote|Updated|Deleted)\s+/, '')
                .replace(/\s*\(new file\)\s*$/, '')
                .trim());
            return paths.filter((p) => p.length > 0);
        }
        // Legacy JSON outputs (kept for backward compatibility with old sessions/tests).
        try {
            const parsed = JSON.parse(result);
            const parsedRecord = parsed && typeof parsed === 'object' ? parsed : undefined;
            const output = parsedRecord?.output;
            if (Array.isArray(output)) {
                return output
                    .filter((item) => typeof item === 'object' &&
                    item !== null &&
                    item.success === true &&
                    typeof item.path === 'string')
                    .map((item) => item.path);
            }
            if (parsedRecord?.success === true && typeof parsedRecord.path === 'string') {
                return [parsedRecord.path];
            }
        }
        catch {
            // Ignore JSON parse errors.
        }
        return [];
    }
    async isYellowCommandApproved(command, taskContext) {
        if (!this.#agentClient)
            return false;
        try {
            const advisories = await evaluateShellAutoApprovalAdvisories({
                commands: [{ id: '__subagent_worker_shell__', command }],
                history: taskContext
                    ? [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: taskContext }] }]
                    : [],
                settingsService: this.#settings,
                agentClient: this.#agentClient,
                logger: this.#logger,
                sessionContextService: this.#sessionContextService,
            });
            return advisories.get('__subagent_worker_shell__')?.approved === true;
        }
        catch (error) {
            this.#logger.warn('Worker shell YELLOW auto-approval evaluation failed', {
                error: error?.message || String(error),
            });
            return false;
        }
    }
    wrapShellTool(definition, cwd, filesChanged, taskContext, validationCapture) {
        const originalExecute = definition.execute.bind(definition);
        const originalNeedsApproval = definition.needsApproval.bind(definition);
        return {
            ...definition,
            needsApproval: () => false,
            execute: async (params, context, details) => {
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
                const underlyingNeedsApproval = autoApproveMode !== 'always' && (await originalNeedsApproval(params, context)) === true;
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
                    let beforeSnapshots;
                    try {
                        beforeSnapshots = new Map(extractedPaths.map((filePath) => [filePath, snapshotShellFile(filePath)]));
                        const result = await originalExecute(params, context, details);
                        captureValidationIfMatch(validationCapture, command, result);
                        return result;
                    }
                    finally {
                        try {
                            if (beforeSnapshots) {
                                filesChanged.push(...extractedPaths.filter((filePath) => shellFileChanged(beforeSnapshots.get(filePath), filePath)));
                            }
                        }
                        finally {
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
    wrapNestedShellTool(definition, cwd) {
        const originalExecute = definition.execute.bind(definition);
        const originalNeedsApproval = definition.needsApproval.bind(definition);
        return {
            ...definition,
            needsApproval: async (params, context) => this.#settings.get('shell.autoApproveMode') === 'always' ? false : await originalNeedsApproval(params, context),
            execute: async (params, context, details) => {
                const unsandboxedError = rejectUnsandboxedSubagentShell(params);
                if (unsandboxedError) {
                    return unsandboxedError;
                }
                const command = getShellCommand(params);
                const { paths: extractedPaths, hasUnresolvedWrite } = command
                    ? this.inspectShellWriteTargets(command, cwd)
                    : { paths: [], hasUnresolvedWrite: false, parseUnknown: false };
                const bypassWorkspaceWriteBoundary = shouldBypassToolApproval(definition.name, this.#settings.get('shell.autoApproveMode'));
                const sandboxOwnsContainment = this.#settings.get('sandbox.enabled') !== false;
                if (hasUnresolvedWrite && !sandboxOwnsContainment && !bypassWorkspaceWriteBoundary) {
                    return `Error: command blocked - could not determine shell write targets safely outside the sandbox. Command: ${command}`;
                }
                for (const filePath of extractedPaths) {
                    if (!bypassWorkspaceWriteBoundary && !this.isWithinWriteBoundary(filePath, cwd)) {
                        return `Error: command blocked - target path "${filePath}" is outside the allowed write boundary. Command: ${command}`;
                    }
                }
                const releaseWorkerLocks = extractedPaths.length > 0 ? this.tryAcquireWorkerWriteLocks(extractedPaths, cwd) : () => { };
                if (!releaseWorkerLocks) {
                    return 'Error: command blocked - one or more target files are already being modified by another worker.';
                }
                let beforeSnapshots;
                try {
                    beforeSnapshots = new Map(extractedPaths.map((filePath) => [filePath, snapshotShellFile(filePath)]));
                    const result = await originalExecute(params, context, details);
                    const ctx = getSubagentRunContext(context);
                    if (ctx?.lastValidation) {
                        captureValidationIfMatch(ctx.lastValidation, command, result);
                    }
                    return result;
                }
                finally {
                    try {
                        const ctx = getSubagentRunContext(context);
                        if (beforeSnapshots) {
                            ctx?.filesChanged.push(...extractedPaths.filter((filePath) => shellFileChanged(beforeSnapshots.get(filePath), filePath)));
                        }
                    }
                    finally {
                        releaseWorkerLocks();
                    }
                }
            },
        };
    }
    wrapReadOnlyShellTool(definition) {
        const originalExecute = definition.execute.bind(definition);
        const cwd = this.#executionContext?.getCwd() ?? process.cwd();
        return {
            ...definition,
            needsApproval: () => false,
            execute: async (params, context, details) => {
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
    wrapWriteTool(definition, cwd, filesChanged, extractPaths, nestedApprovals = false, diffDeltas) {
        const originalExecute = definition.execute.bind(definition);
        const originalNeedsApproval = definition.needsApproval.bind(definition);
        return {
            ...definition,
            needsApproval: nestedApprovals
                ? async (params, context) => {
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
            execute: async (params, context, details) => {
                const paths = extractPaths(params);
                const bypassWorkspaceWriteBoundary = shouldBypassToolApproval(definition.name, this.#settings.get('shell.autoApproveMode'));
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
                const beforeSnapshots = new Map();
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
                                if (delta)
                                    ctx.diffDeltas.set(resolvedPath, delta);
                            }
                        }
                        else {
                            filesChanged.push(successfulPath);
                            if (diffDeltas) {
                                const delta = computeLineDelta(resolvedPath, beforeSnapshots.get(resolvedPath) ?? null);
                                if (delta)
                                    diffDeltas.set(resolvedPath, delta);
                            }
                        }
                    }
                    return result;
                }
                finally {
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
    wrapReadToolWithScope(definition, scopePatterns, extractPath) {
        // No scope defined — no fine-grained restriction
        if (scopePatterns === undefined)
            return definition;
        const originalExecute = definition.execute.bind(definition);
        return {
            ...definition,
            execute: async (params, context, details) => {
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
    wrapWriteToolWithScope(definition, scopePatterns, extractPaths) {
        if (scopePatterns === undefined)
            return definition;
        const originalExecute = definition.execute.bind(definition);
        return {
            ...definition,
            execute: async (params, context, details) => {
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
    wrapShellToolWithScope(definition, scopePatterns) {
        if (scopePatterns !== undefined) {
            return {
                ...definition,
                execute: async () => 'Error: Shell access is not permitted when filesystem scopes are configured. ' +
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
    wrapNetworkToolWithScope(definition, hostPatterns, extractUrl) {
        if (hostPatterns === undefined)
            return definition;
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
                execute: async () => `Error: Permission denied: web_fetch cannot be used with finite host scopes ` +
                    `because the underlying HTTP library may follow redirects transparently ` +
                    `to hosts outside the allowed scope. To allow web_fetch under network ` +
                    `restrictions, use hosts: ['*'] (all hosts). Otherwise, remove ` +
                    `web_fetch from the tool set or omit network host scopes entirely.`,
            };
        }
        const originalExecute = definition.execute.bind(definition);
        return {
            ...definition,
            execute: async (params, context, details) => {
                const url = extractUrl(params);
                if (url) {
                    // Host-specific validation: check the exact URL host
                    if (!isHostInScope(url, hostPatterns)) {
                        return `Error: Host "${url}" is not in the allowed network hosts.`;
                    }
                }
                else {
                    // No extractable URL (e.g., web_search with only a query).
                    // This tool has no target host; it requires the wildcard scope.
                    if (!hostPatterns.includes('*')) {
                        return (`Error: Network access denied: the "${definition.name}" tool has no target host ` +
                            `and requires the '*' wildcard host scope to operate under network restrictions.`);
                    }
                }
                return originalExecute(params, context, details);
            },
        };
    }
}
export class SubagentToolFactory {
    #driverFactory;
    #modelBinding;
    #settings;
    #logger;
    #executionContext;
    #toolPolicy;
    #skillsService;
    #memoryCapabilities;
    #nestedCompatibility;
    #readOnly;
    #shellSandboxRunner;
    #scopedSandbox;
    #runExplorer;
    #sessionBrowser;
    constructor(deps) {
        this.#driverFactory = deps.driverFactory;
        this.#modelBinding = deps.modelBinding;
        this.#settings = deps.settings;
        this.#logger = deps.logger;
        this.#executionContext = deps.executionContext;
        this.#toolPolicy = deps.toolPolicy;
        this.#skillsService = deps.skillsService;
        this.#nestedCompatibility = deps.nestedCompatibility;
        this.#readOnly = deps.readOnly ?? false;
        this.#shellSandboxRunner = deps.scopedSandbox?.runner ?? deps.shellSandboxRunner;
        this.#scopedSandbox = deps.scopedSandbox;
        this.#sessionBrowser = deps.sessionBrowser;
        this.#memoryCapabilities = new MemoryCapabilityBuilder(deps.settings);
    }
    /**
     * Supplies the explorer spawn path for the reviewer's `run_explorer` tool.
     * Set after construction because the runners that execute explorers are
     * built from this factory.
     */
    setExplorerRunner(runExplorer) {
        this.#runExplorer = runExplorer;
    }
    buildToolDefinitions(definition, filesChanged, taskContext, searchViaShell, nestedApprovals = false, diffDeltas, validationCapture, askOrchestrator, options) {
        const tools = [];
        const executionContext = options?.executionContext ?? this.#executionContext;
        const cwd = executionContext?.getCwd() ?? process.cwd();
        const isRemote = executionContext?.isRemote() ?? false;
        // Mentor is advisory-only; it must never inherit incidental capabilities.
        if (definition.role === 'mentor')
            return tools;
        // Reviewer's only capability is delegating evidence collection to
        // explorers; it receives no skills, memory, orchestrator, or workspace tools.
        if (definition.role === 'reviewer') {
            if (this.#runExplorer)
                tools.push(createRunExplorerToolDefinition(this.#runExplorer));
            registerToolFormatters(tools);
            return tools;
        }
        // This callback is supplied exclusively by the async execution-segment
        // adapter. Sync and nested runners never receive it.
        if (askOrchestrator && ['agent', 'explorer', 'worker', 'librarian'].includes(definition.role)) {
            tools.push(createAskOrchestratorToolDefinition(askOrchestrator));
        }
        const features = {
            web: definition.canSearchWeb === true,
            activateSkill: !definition.isScriptGeneric && Boolean(this.#skillsService),
        };
        if (features.activateSkill && this.#skillsService) {
            const activateSkill = createSelectedActivateSkillTool(this.#skillsService);
            if (activateSkill)
                tools.push(activateSkill);
        }
        tools.push(...this.#memoryCapabilities.build({ kind: 'subagent', role: definition.role }, { projectPath: cwd }).tools);
        // History digging belongs to the librarian so raw transcript pages stay
        // out of the parent's context.
        if (definition.role === 'librarian' && this.#sessionBrowser) {
            tools.push(...createSessionBrowserToolDefinitions(this.#sessionBrowser));
        }
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
            tools.push(this.#toolPolicy.wrapReadToolWithScope(createReadFileToolDefinition({
                executionContext,
                allowOutsideWorkspace: false,
                nestedCompatibility: this.#nestedCompatibility,
            }), fsReadScope, (params) => params.path));
            if (dedicatedSearchAvailable) {
                tools.push(this.#toolPolicy.wrapReadToolWithScope(createGrepToolDefinition({
                    executionContext,
                    globAvailable,
                    nestedCompatibility: this.#nestedCompatibility,
                }), fsReadScope, (params) => params.path), this.#toolPolicy.wrapReadToolWithScope(createFindFilesToolDefinition({
                    executionContext,
                    nestedCompatibility: this.#nestedCompatibility,
                }), fsReadScope, (params) => 
                // When path is omitted, the tool defaults to searching from the
                // workspace root (CWD). Use the workspace root as the base path
                // for scope validation. Never treat the glob pattern as a path.
                params.path ?? '.'));
            }
            if (!isRemote) {
                tools.push(this.#toolPolicy.wrapReadToolWithScope(createReadCodeOutlineToolDefinition({ executionContext }), fsReadScope, (params) => params.path), this.#toolPolicy.wrapReadToolWithScope(createCodeContextSearchToolDefinition({ executionContext, globAvailable }), fsReadScope, (params) => params.path));
            }
        }
        if (features.web) {
            const [webSearch, webFetch] = createWebToolDefinitions({
                settingsService: this.#settings,
                loggingService: this.#logger,
            });
            tools.push(this.#toolPolicy.wrapNetworkToolWithScope(webSearch, netScope, () => undefined), this.#toolPolicy.wrapNetworkToolWithScope(webFetch, netScope, (params) => params.url));
        }
        if (definition.canRunShell) {
            const shellDef = this.#toolPolicy.wrapShellToolWithScope(createShellToolDefinition({
                settingsService: this.#settings,
                loggingService: this.#logger,
                executionContext,
                searchViaShell,
                readOnly: this.#readOnly,
                nestedCompatibility: this.#nestedCompatibility,
                ...(this.#shellSandboxRunner ? { shellSandboxRunner: this.#shellSandboxRunner } : {}),
                ...(this.#scopedSandbox
                    ? {
                        registerSandboxNetworkPauseController: this.#scopedSandbox.registerPauseController,
                        sandboxChildRegistry: this.#scopedSandbox.childRegistry,
                    }
                    : {}),
            }), fsReadScope);
            if (definition.canWrite && !this.#readOnly) {
                tools.push(nestedApprovals
                    ? this.#toolPolicy.wrapNestedShellTool(shellDef, cwd)
                    : this.#toolPolicy.wrapShellTool(shellDef, cwd, filesChanged, taskContext, validationCapture));
            }
            else {
                tools.push(this.#toolPolicy.wrapReadOnlyShellTool(shellDef));
            }
        }
        if (definition.canWrite && !this.#readOnly) {
            const usesPatchEditingSurface = shouldPreferPatchEditingModel(definition.model);
            if (usesPatchEditingSurface) {
                tools.push(this.#toolPolicy.wrapWriteToolWithScope(this.#toolPolicy.wrapWriteTool(createApplyPatchToolDefinition({
                    patchHealing: (path, diff, content, diagnosis, model, key, healingDeps) => healPatchOperation(path, diff, content, diagnosis, model, key, {
                        ...healingDeps,
                        driverFactory: this.#driverFactory,
                        modelBinding: this.#modelBinding,
                    }),
                    settingsService: this.#settings,
                    loggingService: this.#logger,
                    executionContext,
                }), cwd, filesChanged, (params) => extractPatchPaths(params.patch), nestedApprovals, diffDeltas), fsWriteScope, (params) => extractPatchPaths(params.patch)));
            }
            else {
                tools.push(this.#toolPolicy.wrapWriteToolWithScope(this.#toolPolicy.wrapWriteTool(createSearchReplaceToolDefinition({
                    editHealing: (params, content, model, key, healingDeps) => healSearchReplaceParams(params, content, model, key, {
                        ...healingDeps,
                        driverFactory: this.#driverFactory,
                        modelBinding: this.#modelBinding,
                    }),
                    settingsService: this.#settings,
                    loggingService: this.#logger,
                    executionContext,
                }), cwd, filesChanged, (params) => (params.path ? [params.path] : []), nestedApprovals, diffDeltas), fsWriteScope, (params) => (params.path ? [params.path] : [])), this.#toolPolicy.wrapWriteToolWithScope(this.#toolPolicy.wrapWriteTool(createCreateFileToolDefinition({
                    settingsService: this.#settings,
                    loggingService: this.#logger,
                    executionContext,
                }), cwd, filesChanged, (params) => (params.path ? [params.path] : []), nestedApprovals, diffDeltas), fsWriteScope, (params) => (params.path ? [params.path] : [])));
            }
        }
        registerToolFormatters(tools);
        // Honor explicit tool allowlist from the definition.
        // When a non-empty allowlist is present, only provision tools
        // whose names appear in it. This lets AgentRuntime pass resolved
        // tool lists through to ExecutionSubagentRunner.
        if (definition.isScriptGeneric) {
            const allowed = new Set(definition.tools ?? []);
            return tools.filter((tool) => allowed.has(tool.name));
        }
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
    buildAgentTools(toolDefinitions, options) {
        const providerDef = this.#modelBinding
            ? this.#modelBinding.providerDefinition(options.providerId)
            : getProvider(options.providerId);
        const capabilities = {
            supportsConversationChaining: providerDef?.capabilities?.supportsConversationChaining ?? false,
            usesStrictToolSchema: providerDef?.capabilities?.usesStrictToolSchema,
        };
        const useStrictSchema = shouldUseStrictToolSchema({
            providerId: options.providerId,
            capabilities,
        });
        return toolDefinitions.map((definition) => {
            const canonicalParameters = definition.canonicalParameters ??
                (isZodToolParameterSchema(definition.parameters) ? definition.parameters : undefined);
            const wrapped = {
                ...definition,
                canonicalParameters,
                parameters: useStrictSchema && isZodToolParameterSchema(definition.parameters)
                    ? toOpenAIStrictToolSchema(definition.parameters)
                    : definition.parameters,
                needsApproval: wrapNeedsApproval(definition, {
                    bypassApproval: () => shouldBypassToolApproval(definition.name, this.#settings.get('shell.autoApproveMode')),
                    registry: options.approvalPolicyRegistry,
                }),
                execute: async (params, context, details) => {
                    options.onToolStart?.(definition.name, params, formatRunningCommandMessages(definition, params), context, details);
                    const maxOutputLength = this.#settings.get('shell.maxOutputChars');
                    let result;
                    try {
                        result = await definition.execute(params, context, details);
                    }
                    finally {
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
            return wrapToolInvoke(wrapped, isZodToolParameterSchema(definition.parameters) ? definition.parameters : undefined, { argumentParsing: definition.argumentParsing });
        });
    }
}
//# sourceMappingURL=tool-policy.js.map