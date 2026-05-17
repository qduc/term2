import { Agent, run, tool as createTool, type Tool } from '@openai/agents';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import type { ILoggingService, ISettingsService } from '../service-interfaces.js';
import { ExecutionContext } from '../execution-context.js';
import { getProvider } from '../../providers/index.js';
import { SubagentSession } from './subagent-session.js';
import type { SubagentRequest, SubagentResult, SubagentDefinition, SubagentRole } from './types.js';
import type { ToolDefinition } from '../../tools/types.js';
import { wrapToolInvoke } from '../../lib/tool-invoke.js';
import { wrapNeedsApproval } from '../../lib/openai-agent-client.js';
import { toOpenAIStrictToolSchema } from '../../lib/openai-strict-tool-schema.js';
import { shouldUseStrictToolSchema } from '../../lib/tool-selection-policy.js';
import { createReadFileToolDefinition } from '../../tools/read-file.js';
import { createGrepToolDefinition } from '../../tools/grep.js';
import { createFindFilesToolDefinition } from '../../tools/find-files.js';
import {
  createReadCodeOutlineToolDefinition,
  createCodeContextSearchToolDefinition,
} from '../../tools/code-context.js';
import { createWebSearchToolDefinition } from '../../tools/web-search.js';
import { createWebFetchToolDefinition } from '../../tools/web-fetch.js';
import { createApplyPatchToolDefinition } from '../../tools/apply-patch.js';
import { createSearchReplaceToolDefinition } from '../../tools/search-replace.js';
import { createCreateFileToolDefinition } from '../../tools/create-file.js';
import { trimToolOutput } from '../../utils/trim-tool-output.js';
import { getEnvInfo, getAgentsInstructions } from '../../agent.js';

const PROMPTS_DIR = path.join(import.meta.dirname, '../../prompts/subagents');
const ROLE_MAX_TURNS_DEFAULT = 20;

function parseFrontmatter(content: string): { frontmatter: Record<string, any>; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: content };
  }

  const frontmatterText = match[1];
  const body = match[2];
  const frontmatter: Record<string, any> = {};

  for (const line of frontmatterText.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const raw = line.slice(colonIdx + 1).trim();
    if (raw === 'true') {
      frontmatter[key] = true;
    } else if (raw === 'false') {
      frontmatter[key] = false;
    } else if (!isNaN(Number(raw)) && raw !== '') {
      frontmatter[key] = Number(raw);
    } else {
      frontmatter[key] = raw;
    }
  }

  return { frontmatter, body: body.trim() };
}

function loadRoleDefinition(role: SubagentRole, settings: ISettingsService): SubagentDefinition {
  const filePath = path.join(PROMPTS_DIR, `${role}.md`);

  if (!fs.existsSync(filePath)) {
    throw new Error(`Unknown subagent role: "${role}". No definition found at ${filePath}`);
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const { frontmatter, body } = parseFrontmatter(content);

  const resolve = (value: any, settingKey: string, defaultValue: any): any => {
    if (value === 'inherit' || value === undefined || value === null || value === '') {
      return settings.get(settingKey) ?? defaultValue;
    }
    return value;
  };

  return {
    role,
    name: frontmatter.name ?? role,
    instructions: body,
    canRead: frontmatter.canRead ?? false,
    canWrite: frontmatter.canWrite ?? false,
    canSearchWeb: frontmatter.canSearchWeb ?? false,
    canRunShell: frontmatter.canRunShell ?? false,
    maxTurns: frontmatter.maxTurns ?? ROLE_MAX_TURNS_DEFAULT,
    model: resolve(frontmatter.model, 'agent.model', 'gpt-4o'),
    provider: resolve(frontmatter.provider, 'agent.provider', 'openai'),
    reasoningEffort: resolve(frontmatter.reasoningEffort, 'agent.reasoningEffort', 'default'),
  };
}

function buildAgentTools(
  toolDefinitions: ToolDefinition[],
  options: {
    providerId: string;
    logger: ILoggingService;
    settings: ISettingsService;
    onToolStart?: (toolName: string) => void;
    onToolComplete?: (toolName: string) => void;
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
        execute: async (params, _context) => {
          options.onToolStart?.(definition.name);
          const maxOutputLength = options.settings.get<number | undefined>('shell.maxOutputChars');
          const result = await definition.execute(params, _context);
          options.onToolComplete?.(definition.name);
          return trimToolOutput(result, undefined, maxOutputLength ?? undefined);
        },
      }),
    ),
  );
}

function runWithProvider(providerId: string, runner: any, agent: Agent, input: any, options: any): Promise<any> {
  const providerDef = getProvider(providerId);
  const supportsTracingControl = providerDef?.capabilities?.supportsTracingControl ?? false;
  const effectiveOptions = { ...options };
  if (!supportsTracingControl) {
    effectiveOptions.tracingDisabled = true;
  }

  if (!runner && providerId !== 'openai') {
    const label = providerDef?.label || providerId;
    throw new Error(
      `${label} is configured but could not be initialized. ` +
        `Please check that all required credentials and provider settings are set.`,
    );
  }

  return runner ? runner.run(agent, input, effectiveOptions) : run(agent, input, effectiveOptions);
}

function extractFinalText(result: any): string {
  if (typeof result.finalOutput === 'string' && result.finalOutput) {
    return result.finalOutput;
  }

  if (Array.isArray(result.history)) {
    for (let i = result.history.length - 1; i >= 0; i--) {
      const item: any = result.history[i];
      const raw = item?.rawItem ?? item;
      if (raw?.role === 'assistant') {
        const content = raw?.content;
        if (typeof content === 'string') return content;
        if (Array.isArray(content)) {
          return content
            .filter((c: any) => typeof c?.text === 'string')
            .map((c: any) => c.text)
            .join('');
        }
      }
    }
  }

  return '';
}

function aggregateToolUsage(toolCounts: Map<string, number>): Array<{ toolName: string; count: number }> {
  return Array.from(toolCounts.entries()).map(([toolName, count]) => ({ toolName, count }));
}

export class SubagentManager {
  #logger: ILoggingService;
  #settings: ISettingsService;
  #executionContext?: ExecutionContext;
  #mentorSession: SubagentSession;

  constructor(deps: { logger: ILoggingService; settings: ISettingsService; executionContext?: ExecutionContext }) {
    this.#logger = deps.logger;
    this.#settings = deps.settings;
    this.#executionContext = deps.executionContext;
    this.#mentorSession = new SubagentSession(randomUUID(), 'mentor');
  }

  resetMentorSession(): void {
    this.#mentorSession.reset();
  }

  async run(request: SubagentRequest): Promise<SubagentResult> {
    const agentId = randomUUID();

    this.#logger.debug('SubagentManager.run', { agentId, role: request.role, taskLength: request.task.length });

    try {
      if (request.role === 'mentor') {
        return await this.#runMentor(agentId, request.task);
      }

      const definition = loadRoleDefinition(request.role, this.#settings);
      return await this.#runSubagent(agentId, request, definition);
    } catch (error: any) {
      this.#logger.error('Subagent run failed', { agentId, role: request.role, error: error?.message });
      return {
        agentId,
        role: request.role,
        status: 'failed',
        finalText: '',
        filesChanged: [],
        toolsUsed: [],
        error: error?.message || String(error),
      };
    }
  }

  async #runMentor(agentId: string, task: string): Promise<SubagentResult> {
    const mentorModel = this.#settings.get<string>('agent.mentorModel');
    if (!mentorModel) {
      throw new Error('Mentor model is not configured');
    }

    const mentorProvider =
      this.#settings.get<string>('agent.mentorProvider') ?? this.#settings.get<string>('agent.provider') ?? 'openai';
    const mentorMode = this.#settings.get<boolean>('app.mentorMode');

    const baseInstructions = mentorMode
      ? 'You are a senior architect acting as a peer reviewer. You have no codebase access—you rely on what the user reports.\n\n' +
        'Your role is adversarial review, not rubber-stamping:\n' +
        '- Challenge assumptions, even when reasoning sounds solid\n' +
        '- Probe for gaps: what did they not check? What could go wrong?\n' +
        '- Suggest alternatives they may have dismissed too quickly\n' +
        '- Ask for evidence when confidence seems misplaced\n\n' +
        'When satisfied, give clear approval with specific next steps. When not, say exactly what needs more investigation.\n\n' +
        "Be concise. Push back hard, but don't block unnecessarily."
      : 'You are a helpful mentor assistant. Provide advice and guidance on technical problems. Be concise and actionable.';

    const envInfo = getEnvInfo(this.#settings, this.#executionContext);
    const cwd = this.#executionContext?.getCwd() ?? process.cwd();
    const agentsInstructions = this.#executionContext?.isRemote() ? '' : getAgentsInstructions(cwd);
    const instructions = `${baseInstructions}\n\nEnvironment: ${envInfo}${agentsInstructions}`;

    this.#mentorSession.switchProvider(mentorProvider);

    const mentorRunner = this.#mentorSession.ensureRunner(mentorProvider, (providerId) => {
      const providerDef = getProvider(providerId);
      return providerDef?.createRunner?.({ settingsService: this.#settings, loggingService: this.#logger }) ?? null;
    });

    const mentorAgent = this.#mentorSession.ensureAgent(() => {
      const reasoningEffort = this.#settings.get<string>('agent.mentorReasoningEffort');
      const modelSettings: any = {};
      if (reasoningEffort && reasoningEffort !== 'default') {
        modelSettings.reasoning = { effort: reasoningEffort, summary: 'auto' };
      }

      return new Agent({
        name: 'Mentor',
        model: mentorModel,
        ...(Object.keys(modelSettings).length > 0 ? { modelSettings } : {}),
        instructions,
      });
    });

    this.#mentorSession.addUserMessage(task);

    const providerDef = getProvider(mentorProvider);
    const supportsChaining = providerDef?.capabilities?.supportsConversationChaining ?? false;
    const input = this.#mentorSession.getInput(task, supportsChaining);
    const runOptions = this.#mentorSession.getRunOptions(supportsChaining, 1);

    const result = await runWithProvider(mentorProvider, mentorRunner, mentorAgent, input, runOptions);
    this.#mentorSession.updateFromResult(result);

    return {
      agentId,
      role: 'mentor',
      status: 'completed',
      finalText: extractFinalText(result),
      filesChanged: [],
      toolsUsed: [],
    };
  }

  async #runSubagent(
    agentId: string,
    request: SubagentRequest,
    definition: SubagentDefinition,
  ): Promise<SubagentResult> {
    const toolCounts = new Map<string, number>();
    const filesChanged: string[] = [];

    const toolDefinitions = this.#buildToolDefinitions(definition, request.writeBoundary, filesChanged);

    const providerId = definition.provider;
    const tools = buildAgentTools(toolDefinitions, {
      providerId,
      logger: this.#logger,
      settings: this.#settings,
      onToolStart: (name) => {
        toolCounts.set(name, (toolCounts.get(name) ?? 0) + 1);
      },
    });

    const providerDef = getProvider(providerId);
    const runner =
      providerId !== 'openai'
        ? providerDef?.createRunner?.({ settingsService: this.#settings, loggingService: this.#logger }) ?? null
        : null;

    const modelSettings: any = {};
    if (definition.reasoningEffort && definition.reasoningEffort !== 'default') {
      modelSettings.reasoning = { effort: definition.reasoningEffort, summary: 'auto' };
    }

    const envInfo = getEnvInfo(this.#settings, this.#executionContext);
    const cwd = this.#executionContext?.getCwd() ?? process.cwd();
    const agentsInstructions = this.#executionContext?.isRemote() ? '' : getAgentsInstructions(cwd);

    const fullInstructions = [
      definition.instructions,
      `Environment: ${envInfo}${agentsInstructions}`,
      request.writeBoundary?.length
        ? `Write boundary: you may only write to paths within: ${request.writeBoundary.join(', ')}`
        : '',
    ]
      .filter(Boolean)
      .join('\n\n');

    const agent = new Agent({
      name: definition.name,
      model: definition.model,
      ...(Object.keys(modelSettings).length > 0 ? { modelSettings } : {}),
      instructions: fullInstructions,
      tools,
    });

    const result = await runWithProvider(providerId, runner, agent, request.task, {
      stream: false,
      maxTurns: definition.maxTurns,
    });

    return {
      agentId,
      role: request.role,
      status: 'completed',
      finalText: extractFinalText(result),
      filesChanged: [...new Set(filesChanged)],
      toolsUsed: aggregateToolUsage(toolCounts),
    };
  }

  #buildToolDefinitions(
    definition: SubagentDefinition,
    writeBoundary: string[] | undefined,
    filesChanged: string[],
  ): ToolDefinition[] {
    const tools: ToolDefinition[] = [];
    const cwd = this.#executionContext?.getCwd() ?? process.cwd();
    const isRemote = this.#executionContext?.isRemote() ?? false;

    if (definition.canRead) {
      tools.push(
        createReadFileToolDefinition({ executionContext: this.#executionContext, allowOutsideWorkspace: false }),
        createGrepToolDefinition({ executionContext: this.#executionContext }),
        createFindFilesToolDefinition({ executionContext: this.#executionContext }),
      );

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

    if (definition.canWrite) {
      tools.push(
        this.#wrapWriteTool(
          createApplyPatchToolDefinition({
            settingsService: this.#settings,
            loggingService: this.#logger,
            executionContext: this.#executionContext,
          }),
          writeBoundary,
          cwd,
          filesChanged,
          (params: any) => this.#extractPathsFromApplyPatch(params),
        ),
        this.#wrapWriteTool(
          createSearchReplaceToolDefinition({
            settingsService: this.#settings,
            loggingService: this.#logger,
            executionContext: this.#executionContext,
          }),
          writeBoundary,
          cwd,
          filesChanged,
          (params: any) => (params?.path ? [params.path] : []),
        ),
        this.#wrapWriteTool(
          createCreateFileToolDefinition({
            settingsService: this.#settings,
            loggingService: this.#logger,
            executionContext: this.#executionContext,
          }),
          writeBoundary,
          cwd,
          filesChanged,
          (params: any) => (params?.path ? [params.path] : []),
        ),
      );
    }

    return tools;
  }

  #extractPathsFromApplyPatch(params: any): string[] {
    if (Array.isArray(params?.operations)) {
      return params.operations.map((op: any) => op?.path).filter(Boolean);
    }
    return params?.path ? [params.path] : [];
  }

  #wrapWriteTool(
    definition: ToolDefinition,
    writeBoundary: string[] | undefined,
    cwd: string,
    filesChanged: string[],
    extractPaths: (params: any) => string[],
  ): ToolDefinition {
    const originalExecute = definition.execute.bind(definition);

    return {
      ...definition,
      needsApproval: () => false,
      execute: async (params: any, context?: unknown) => {
        if (writeBoundary?.length) {
          const paths = extractPaths(params);
          for (const filePath of paths) {
            const resolved = path.resolve(cwd, filePath);
            const withinBoundary = writeBoundary.some((boundary) => {
              const resolvedBoundary = path.resolve(cwd, boundary);
              return resolved === resolvedBoundary || resolved.startsWith(resolvedBoundary + path.sep);
            });
            if (!withinBoundary) {
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
        }

        const result = await originalExecute(params, context);

        const paths = extractPaths(params);
        for (const p of paths) {
          filesChanged.push(p);
        }

        return result;
      },
    };
  }
}
