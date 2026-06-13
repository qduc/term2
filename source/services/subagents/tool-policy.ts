import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { tool as createTool, type Tool, type RunContext } from '@openai/agents';
import type { ILoggingService, ISettingsService, ISessionContextService } from '../service-interfaces.js';
import type { ExecutionContext } from '../execution-context.js';
import type { SubagentDefinition, SupportedSubagentRole } from './types.js';
import type { CommandMessage, ToolDefinition } from '../../tools/types.js';
import { getProvider } from '../../providers/index.js';
import { wrapToolInvoke, wrapNeedsApproval } from '../../lib/tool-invoke.js';
import { toOpenAIStrictToolSchema } from '../../lib/openai-strict-tool-schema.js';
import { shouldUseStrictToolSchema, shouldPreferPatchEditingModel } from '../../lib/tool-selection-policy.js';
import { createReadFileToolDefinition } from '../../tools/file/read-file.js';
import { createGrepToolDefinition } from '../../tools/system/grep.js';
import { createFindFilesToolDefinition } from '../../tools/file/find-files.js';
import {
  createReadCodeOutlineToolDefinition,
  createCodeContextSearchToolDefinition,
} from '../../tools/system/code-context.js';
import { createWebSearchToolDefinition } from '../../tools/web/web-search.js';
import { createWebFetchToolDefinition } from '../../tools/web/web-fetch.js';
import { createApplyPatchToolDefinition } from '../../tools/file/apply-patch.js';
import { createSearchReplaceToolDefinition } from '../../tools/file/search-replace.js';
import { createCreateFileToolDefinition } from '../../tools/file/create-file.js';
import { createShellToolDefinition } from '../../tools/system/shell.js';
import { registerToolFormatters } from '../../tools/command-message-formatters.js';
import { trimToolOutput } from '../../utils/output/trim-tool-output.js';
import { injectWarningIntoToolOutput } from '../../utils/inject-warning-into-tool-output.js';
import { tryAcquireFileLock } from '../../tools/file/file-locks.js';
import { classifyCommand, SafetyStatus } from '../../utils/shell/command-safety/index.js';
import { evaluateShellAutoApprovalAdvisories } from '../approval/shell-auto-approval-evaluator.js';
import type { ISubagentClient } from './subagent-client-types.js';

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
      return [];
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
            return JSON.stringify({
              output: [
                {
                  success: false,
                  error: `Write rejected: path "${filePath}" is outside the allowed write boundary.`,
                },
              ],
            });
          }
        }

        const releaseWorkerLocks = this.tryAcquireWorkerWriteLocks(paths, cwd);
        if (!releaseWorkerLocks) {
          return JSON.stringify({
            output: [
              {
                success: false,
                error: 'Write rejected: one or more target files are already being modified by another worker.',
              },
            ],
          });
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
}

export class SubagentToolFactory {
  #settings: ISettingsService;
  #logger: ILoggingService;
  #executionContext?: ExecutionContext;
  #toolPolicy: SubagentToolPolicy;

  constructor(deps: {
    settings: ISettingsService;
    logger: ILoggingService;
    executionContext?: ExecutionContext;
    toolPolicy: SubagentToolPolicy;
  }) {
    this.#settings = deps.settings;
    this.#logger = deps.logger;
    this.#executionContext = deps.executionContext;
    this.#toolPolicy = deps.toolPolicy;
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

    if (definition.canRead) {
      tools.push(
        createReadFileToolDefinition({ executionContext: this.#executionContext, allowOutsideWorkspace: false }),
      );

      if (!searchViaShell) {
        tools.push(
          createGrepToolDefinition({ executionContext: this.#executionContext }),
          createFindFilesToolDefinition({ executionContext: this.#executionContext }),
        );
      }

      if (!isRemote) {
        tools.push(
          createReadCodeOutlineToolDefinition({ executionContext: this.#executionContext }),
          createCodeContextSearchToolDefinition({ executionContext: this.#executionContext }),
        );
      }
    }

    if (definition.canSearchWeb) {
      tools.push(
        createWebSearchToolDefinition({ settingsService: this.#settings, loggingService: this.#logger }),
        createWebFetchToolDefinition({ settingsService: this.#settings, loggingService: this.#logger }),
      );
    }

    if (definition.canRunShell) {
      const shellDef = createShellToolDefinition({
        settingsService: this.#settings,
        loggingService: this.#logger,
        executionContext: this.#executionContext,
      });

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
        );
      } else {
        tools.push(
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
        );
      }
    }

    registerToolFormatters(tools);
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
            let trimmedResult = trimToolOutput(result, undefined, maxOutputLength ?? undefined);

            const userContext: any = _context?.context;
            if (userContext && typeof userContext.turnCount === 'number' && typeof userContext.maxTurns === 'number') {
              const turnsLeft = userContext.maxTurns - userContext.turnCount;
              if (turnsLeft >= 0 && turnsLeft <= 5) {
                const warning = `\n\n[Warning: You are approaching the maximum turn limit. You have ${turnsLeft} turns left. Please prepare to wrap up your work and provide a situation update message describing what has been completed and what remains to be done.]`;
                trimmedResult = injectWarningIntoToolOutput(trimmedResult, warning);
              }
            }

            return trimmedResult;
          },
        }),
        definition.parameters,
        { argumentParsing: definition.argumentParsing },
      ),
    );
  }
}
