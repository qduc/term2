import { randomUUID } from 'node:crypto';
import type { Tool, Agent } from '@openai/agents';
import type { ILoggingService, ISettingsService, ISessionContextService } from '../service-interfaces.js';
import type { ExecutionContext } from '../execution-context.js';
import type { SubagentRequest, SubagentResult, SupportedSubagentRole } from './types.js';
import type { ConversationEvent } from '../conversation/conversation-events.js';
import type { ISubagentClient, ISubagentClientFactory } from './subagent-client-types.js';
import { createSubagentRuntime, type SubagentRuntime } from './runtime.js';
import { loadRoleDefinition } from './role-loader.js';
import { isAbortLike, safeEmit } from './utils.js';
import { normalizeAgentRunUsage, extractUsage } from '../../utils/ai/token-usage.js';
import type { SubagentRunContext } from './tool-policy.js';

export class SubagentManager {
  #logger: ILoggingService;
  #settings: ISettingsService;
  #onEvent?: (event: ConversationEvent) => void;
  #runtime: SubagentRuntime;

  constructor(deps: {
    logger: ILoggingService;
    settings: ISettingsService;
    executionContext?: ExecutionContext;
    sessionContextService: ISessionContextService;
    onEvent?: (event: ConversationEvent) => void;
    agentClient?: ISubagentClient;
    createClient?: ISubagentClientFactory['createClient'];
  }) {
    this.#logger = deps.logger;
    this.#settings = deps.settings;
    this.#onEvent = deps.onEvent;
    this.#runtime = createSubagentRuntime(deps);
  }

  resetMentorSession(): void {
    this.#runtime.mentorRunner.reset();
  }

  clearCache(): void {
    this.#runtime.nestedRunner.clearCache();
  }

  getRoleAgentTool(role: SupportedSubagentRole): Tool<SubagentRunContext> {
    return this.#runtime.nestedRunner.getRoleAgentTool(role);
  }

  getRoleAgent(role: SupportedSubagentRole): Agent<SubagentRunContext> {
    return this.#runtime.nestedRunner.getRoleAgent(role);
  }

  async runAsTool(request: SubagentRequest, context?: unknown, details?: unknown): Promise<SubagentResult> {
    return this.#runtime.nestedRunner.runAsTool(request, context, details);
  }

  async run(request: SubagentRequest): Promise<SubagentResult> {
    const agentId = randomUUID();

    this.#logger.debug('SubagentManager.run', { agentId, role: request.role, taskLength: request.task.length });
    safeEmit(this.#logger, this.#onEvent, {
      type: 'subagent_started',
      agentId,
      role: request.role,
      task: request.task,
      parentTool: request.parentTool,
    });

    try {
      const result =
        request.role === 'mentor'
          ? await this.#runtime.mentorRunner.run(agentId, request.task, request.signal)
          : await this.#runtime.executionRunner.run(agentId, request, loadRoleDefinition(request.role, this.#settings));
      safeEmit(this.#logger, this.#onEvent, { type: 'subagent_completed', result });
      return result;
    } catch (error: any) {
      this.#logger.error('Subagent run failed', {
        agentId,
        role: request.role,
        error: error?.message,
        stack: error instanceof Error ? error.stack : undefined,
      });

      const isAbort = isAbortLike(error?.message, error);
      const usage = normalizeAgentRunUsage(error?.state?.usage) ?? extractUsage(error);

      const result: SubagentResult = {
        agentId,
        role: request.role,
        status: isAbort ? 'cancelled' : 'failed',
        finalText: '',
        filesChanged: [],
        toolsUsed: [],
        error: error?.message || String(error),
        ...(usage ? { usage } : {}),
      };
      safeEmit(this.#logger, this.#onEvent, { type: 'subagent_completed', result });
      return result;
    }
  }
}
