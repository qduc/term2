import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { tool as createTool, type Tool, type RunContext } from '@openai/agents';
import type { ILoggingService, ISettingsService, ISessionContextService } from '../service-interfaces.js';
import type { ExecutionContext } from '../execution-context.js';
import type { SubagentDefinition, SupportedSubagentRole } from './types.js';
import type { CommandMessage, ToolDefinition } from '../../tools/types.js';
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
import { createSearchReplaceToolDefinition } from '../../tools/file/search-replace.js';
import { createCreateFileToolDefinition } from '../../tools/file/create-file.js';
import { createShellToolDefinition } from '../../tools/system/shell.js';
import { createActivateSkillToolDefinition } from '../../tools/agent/activate-skill.js';
import type { SkillsService } from '../skills/skills-service.js';
import { registerToolFormatters } from '../../tools/command-message-formatters.js';
import { trimToolOutput } from '../../utils/output/trim-tool-output.js';
import { injectTurnLimitWarning } from '../../utils/inject-warning-into-tool-output.js';
import { tryAcquireFileLock } from '../../tools/file/file-locks.js';
import { classifyCommand, SafetyStatus } from '../../utils/shell/command-safety/index.js';
import { evaluateShellAutoApprovalAdvisories } from '../approval/shell-auto-approval-evaluator.js';
import type { ISubagentClient } from './subagent-client-types.js';
import { MemoryCapabilityBuilder } from '../memory/memory-capabilities.js';

const MODEL_FACING_EDITOR_TOOLS = new Set(['apply_patch', 'search_replace', 'create_file']);

export type SubagentRunContext = {
  agentId: string;
  role: SupportedSubagentRole;
  task: string;
  filesChanged: string[];
  toolCounts: Record<string, number>;
  activeCommandMessages: Record<string, CommandMessage[]>;
  turnCount: number;
  maxTurns: number;
};

export function getSubagentRunContext(context: unknown): SubagentRunContext | undefined {
  const candidate = (context as RunContext<SubagentRunContext> | undefined)?.context;
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

export function formatRunningCommandMessages(definition: ToolDefinition, params: unknown): CommandMessage[] {
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
    const paths: string[] = [];
    try {
      classifyCommand(command, this.#logger);
      const tokens = command.match(/>\s*(\S+)|>>\s*(\S+)|tee\s+(\S+)/gi);
      if (tokens) {
        for (const token of tokens) {
          const match = token.match(/>+\s*(\S+)|tee\s+(\S+)/);
          if (match) {
            const p = match[1] ?? match[2];
            if (p) {
              const resolved = path.resolve(cwd, p);
              paths.push(resolved);
            }
          }
        }
      }
    } catch {
      // Non-fatal
    }
    return [...new Set(paths)];
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
      const parsed = JSON.parse(result);
      if (Array.isArray(parsed?.output)) {
        return parsed.output
          .filter((item: any) => item?.success === true && typeof item?.path === 'string')
          .map((item: any) => item.path);
      }
      if (parsed?.success === true && typeof parsed?.path === 'string') {
        return [parsed.path];
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

  wrapShellTool(definition: ToolDefinition, cwd: string, filesChanged: string[], taskContext: string): ToolDefinition {
    const originalExecute = definition.execute.bind(definition);
    return {
      ...definition,
      needsApproval: () => false,
      execute: async (params: any, context?: unknown, details?: unknown) => {
        const unsandboxedError = rejectUnsandboxedSubagentShell(params);
        if (unsandboxedError) {
          return unsandboxedError;
        }

        const command: string = typeof params?.command === 'string' ? params.command : '';
        if (!command) {
          return originalExecute(params, context, details);
        }

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

        const extractedPaths = this.extractPathsFromCommand(command, cwd);
        if (extractedPaths.length > 0) {
          for (const filePath of extractedPaths) {
            if (!this.isWithinWriteBoundary(filePath, cwd)) {
              return `Error: command blocked — target path "${filePath}" is outside the allowed write boundary. Command: ${command}`;
            }
          }

          const releaseWorkerLocks = this.tryAcquireWorkerWriteLocks(extractedPaths, cwd);
          if (!releaseWorkerLocks) {
            return 'Error: command blocked — one or more target files are already being modified by another worker.';
          }

          try {
            const result = await originalExecute(params, context, details);
            filesChanged.push(...extractedPaths);
            return result;
          } finally {
            releaseWorkerLocks();
          }
        }

        return originalExecute(params, context, details);
      },
    };
  }

  wrapNestedShellTool(definition: ToolDefinition, cwd: string): ToolDefinition {
    const originalExecute = definition.execute.bind(definition);
    return {
      ...definition,
      execute: async (params: any, context?: unknown, details?: unknown) => {
        const unsandboxedError = rejectUnsandboxedSubagentShell(params);
        if (unsandboxedError) {
          return unsandboxedError;
        }

        const command: string = typeof params?.command === 'string' ? params.command : '';
        const extractedPaths = command ? this.extractPathsFromCommand(command, cwd) : [];
        for (const filePath of extractedPaths) {
          if (!this.isWithinWriteBoundary(filePath, cwd)) {
            return `Error: command blocked - target path "${filePath}" is outside the allowed write boundary. Command: ${command}`;
          }
        }

        const releaseWorkerLocks =
          extractedPaths.length > 0 ? this.tryAcquireWorkerWriteLocks(extractedPaths, cwd) : () => {};
        if (!releaseWorkerLocks) {
          return 'Error: command blocked - one or more target files are already being modified by another worker.';
        }

        try {
          const result = await originalExecute(params, context, details);
          getSubagentRunContext(context)?.filesChanged.push(...extractedPaths);
          return result;
        } finally {
          releaseWorkerLocks();
        }
      },
    };
  }

  wrapReadOnlyShellTool(definition: ToolDefinition): ToolDefinition {
    const originalExecute = definition.execute.bind(definition);
    const cwd = this.#executionContext?.getCwd() ?? process.cwd();
    return {
      ...definition,
      needsApproval: () => false,
      execute: async (params: any, context?: unknown, details?: unknown) => {
        const unsandboxedError = rejectUnsandboxedSubagentShell(params);
        if (unsandboxedError) {
          return unsandboxedError;
        }

        const command: string = typeof params?.command === 'string' ? params.command : '';
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

  wrapWriteTool(
    definition: ToolDefinition,
    cwd: string,
    filesChanged: string[],
    extractPaths: (params: any) => string[],
    nestedApprovals = false,
  ): ToolDefinition {
    const originalExecute = definition.execute.bind(definition);
    const originalNeedsApproval = definition.needsApproval.bind(definition);

    return {
      ...definition,
      needsApproval: nestedApprovals
        ? async (params: any, context?: unknown) => {
            const paths = extractPaths(params);
            if (paths.some((filePath) => !this.isWithinWriteBoundary(filePath, cwd))) {
              return false;
            }
            return originalNeedsApproval(params, context);
          }
        : () => false,
      execute: async (params: any, context?: unknown, details?: unknown) => {
        const paths = extractPaths(params);

        for (const filePath of paths) {
          if (!this.isWithinWriteBoundary(filePath, cwd)) {
            return `Error: Write rejected: path "${filePath}" is outside the allowed write boundary.`;
          }
        }

        const releaseWorkerLocks = this.tryAcquireWorkerWriteLocks(paths, cwd);
        if (!releaseWorkerLocks) {
          return 'Error: Write rejected: one or more target files are already being modified by another worker.';
        }

        try {
          const result = await originalExecute(params, context, details);
          for (const successfulPath of this.extractSuccessfulWritePaths(result)) {
            if (nestedApprovals) {
              getSubagentRunContext(context)?.filesChanged.push(successfulPath);
            } else {
              filesChanged.push(successfulPath);
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
  wrapReadToolWithScope(
    definition: ToolDefinition,
    scopePatterns: string[] | undefined,
    extractPath: (params: any) => string | undefined,
  ): ToolDefinition {
    // No scope defined — no fine-grained restriction
    if (scopePatterns === undefined) return definition;

    const originalExecute = definition.execute.bind(definition);
    return {
      ...definition,
      execute: async (params: any, context?: unknown, details?: unknown) => {
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
  wrapWriteToolWithScope(
    definition: ToolDefinition,
    scopePatterns: string[] | undefined,
    extractPaths: (params: any) => string[],
  ): ToolDefinition {
    if (scopePatterns === undefined) return definition;

    const originalExecute = definition.execute.bind(definition);
    return {
      ...definition,
      execute: async (params: any, context?: unknown, details?: unknown) => {
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
  wrapShellToolWithScope(definition: ToolDefinition, scopePatterns: string[] | undefined): ToolDefinition {
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
  wrapNetworkToolWithScope(
    definition: ToolDefinition,
    hostPatterns: string[] | undefined,
    extractUrl: (params: any) => string | undefined,
  ): ToolDefinition {
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
      execute: async (params: any, context?: unknown, details?: unknown) => {
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

  constructor(deps: {
    settings: ISettingsService;
    logger: ILoggingService;
    executionContext?: ExecutionContext;
    toolPolicy: SubagentToolPolicy;
    skillsService?: SkillsService;
  }) {
    this.#settings = deps.settings;
    this.#logger = deps.logger;
    this.#executionContext = deps.executionContext;
    this.#toolPolicy = deps.toolPolicy;
    this.#skillsService = deps.skillsService;
    this.#memoryCapabilities = new MemoryCapabilityBuilder(deps.settings);
  }

  buildToolDefinitions(
    definition: SubagentDefinition,
    filesChanged: string[],
    taskContext: string,
    searchViaShell: boolean,
    nestedApprovals = false,
  ): ToolDefinition[] {
    const tools: ToolDefinition[] = [];
    const cwd = this.#executionContext?.getCwd() ?? process.cwd();
    const isRemote = this.#executionContext?.isRemote() ?? false;

    // Mentor is advisory-only; it must never inherit incidental capabilities.
    if (definition.role === 'mentor') return tools;

    if (this.#skillsService && this.#skillsService.getAvailableSkillsForModel().length > 0) {
      tools.push(createActivateSkillToolDefinition(this.#skillsService));
    }

    tools.push(...this.#memoryCapabilities.build({ kind: 'subagent', role: definition.role }).tools);

    // Extract resolved scopes from definition
    const fsReadScope = definition.filesystemScope?.read;
    const fsWriteScope = definition.filesystemScope?.write;
    const netScope = definition.networkScope;

    if (definition.canRead) {
      tools.push(
        this.#toolPolicy.wrapReadToolWithScope(
          createReadFileToolDefinition({ executionContext: this.#executionContext, allowOutsideWorkspace: false }),
          fsReadScope,
          (params: any) => params?.path ?? params?.filePath,
        ),
      );

      if (!searchViaShell) {
        tools.push(
          this.#toolPolicy.wrapReadToolWithScope(
            createGrepToolDefinition({ executionContext: this.#executionContext }),
            fsReadScope,
            (params: any) => params?.path,
          ),
          this.#toolPolicy.wrapReadToolWithScope(
            createFindFilesToolDefinition({ executionContext: this.#executionContext }),
            fsReadScope,
            (params: any) =>
              // When path is omitted, the tool defaults to searching from the
              // workspace root (CWD). Use the workspace root as the base path
              // for scope validation. Never treat the glob pattern as a path.
              params?.path ?? '.',
          ),
        );
      }

      if (!isRemote) {
        tools.push(
          this.#toolPolicy.wrapReadToolWithScope(
            createReadCodeOutlineToolDefinition({ executionContext: this.#executionContext }),
            fsReadScope,
            (params: any) => params?.path,
          ),
          this.#toolPolicy.wrapReadToolWithScope(
            createCodeContextSearchToolDefinition({ executionContext: this.#executionContext }),
            fsReadScope,
            (params: any) => params?.path,
          ),
        );
      }
    }

    if (definition.canSearchWeb) {
      tools.push(
        this.#toolPolicy.wrapNetworkToolWithScope(
          createWebSearchToolDefinition({ settingsService: this.#settings, loggingService: this.#logger }),
          netScope,
          (params: any) => (params?.query ? undefined : params?.url),
        ),
        this.#toolPolicy.wrapNetworkToolWithScope(
          createWebFetchToolDefinition({ settingsService: this.#settings, loggingService: this.#logger }),
          netScope,
          (params: any) => params?.url,
        ),
      );
    }

    if (definition.canRunShell) {
      const shellDef = this.#toolPolicy.wrapShellToolWithScope(
        createShellToolDefinition({
          settingsService: this.#settings,
          loggingService: this.#logger,
          executionContext: this.#executionContext,
          searchViaShell,
        }),
        fsReadScope,
      );

      if (definition.canWrite) {
        tools.push(
          nestedApprovals
            ? this.#toolPolicy.wrapNestedShellTool(shellDef, cwd)
            : this.#toolPolicy.wrapShellTool(shellDef, cwd, filesChanged, taskContext),
        );
      } else {
        tools.push(this.#toolPolicy.wrapReadOnlyShellTool(shellDef));
      }
    }

    if (definition.canWrite) {
      const isGpt5 = shouldPreferPatchEditingModel(definition.model);
      if (isGpt5) {
        tools.push(
          this.#toolPolicy.wrapWriteToolWithScope(
            this.#toolPolicy.wrapWriteTool(
              createApplyPatchToolDefinition({
                settingsService: this.#settings,
                loggingService: this.#logger,
                executionContext: this.#executionContext,
              }),
              cwd,
              filesChanged,
              (params: any) => {
                if (Array.isArray(params?.operations)) {
                  return params.operations.map((op: any) => op?.path).filter(Boolean);
                }
                return params?.path ? [params.path] : [];
              },
              nestedApprovals,
            ),
            fsWriteScope,
            (params: any) => {
              if (Array.isArray(params?.operations)) {
                return params.operations.map((op: any) => op?.path).filter(Boolean);
              }
              return params?.path ? [params.path] : [];
            },
          ),
        );
      } else {
        tools.push(
          this.#toolPolicy.wrapWriteToolWithScope(
            this.#toolPolicy.wrapWriteTool(
              createSearchReplaceToolDefinition({
                settingsService: this.#settings,
                loggingService: this.#logger,
                executionContext: this.#executionContext,
              }),
              cwd,
              filesChanged,
              (params: any) => (params?.path ? [params.path] : []),
              nestedApprovals,
            ),
            fsWriteScope,
            (params: any) => (params?.path ? [params.path] : []),
          ),
          this.#toolPolicy.wrapWriteToolWithScope(
            this.#toolPolicy.wrapWriteTool(
              createCreateFileToolDefinition({
                settingsService: this.#settings,
                loggingService: this.#logger,
                executionContext: this.#executionContext,
              }),
              cwd,
              filesChanged,
              (params: any) => (params?.path ? [params.path] : []),
              nestedApprovals,
            ),
            fsWriteScope,
            (params: any) => (params?.path ? [params.path] : []),
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
        if (tool.name === 'activate_skill') {
          return true;
        }
        return MODEL_FACING_EDITOR_TOOLS.has(tool.name) ? editorRequested : allowed.has(tool.name);
      });
    }

    return tools;
  }

  buildAgentTools(
    toolDefinitions: ToolDefinition[],
    options: {
      providerId: string;
      onToolStart?: (
        toolName: string,
        params: unknown,
        commandMessages: CommandMessage[],
        context?: RunContext<unknown>,
        details?: unknown,
      ) => void;
      onToolComplete?: (toolName: string, result: unknown, context?: RunContext<unknown>, details?: unknown) => void;
    },
  ): Tool[] {
    const providerDef = getProvider(options.providerId);
    const capabilities = {
      supportsConversationChaining: providerDef?.capabilities?.supportsConversationChaining ?? false,
      supportsTracingControl: providerDef?.capabilities?.supportsTracingControl ?? false,
      usesStrictToolSchema: providerDef?.capabilities?.usesStrictToolSchema,
    };
    const useStrictSchema = shouldUseStrictToolSchema({
      providerId: options.providerId,
      capabilities,
    });

    return toolDefinitions.map((definition) =>
      wrapToolInvoke(
        createTool({
          name: definition.name,
          description: definition.description,
          parameters: useStrictSchema ? toOpenAIStrictToolSchema(definition.parameters) : definition.parameters,
          needsApproval: wrapNeedsApproval(definition),
          execute: async (params, _context, details) => {
            options.onToolStart?.(
              definition.name,
              params,
              formatRunningCommandMessages(definition, params),
              _context,
              details,
            );
            const maxOutputLength = this.#settings.get<number | undefined>('shell.maxOutputChars');
            const result = await definition.execute(params, _context, details);
            options.onToolComplete?.(definition.name, result, _context, details);
            const trimmedResult = trimToolOutput(result, undefined, maxOutputLength ?? undefined);
            return injectTurnLimitWarning(trimmedResult, _context?.context);
          },
        }),
        definition.parameters,
        { argumentParsing: definition.argumentParsing },
      ),
    );
  }
}
