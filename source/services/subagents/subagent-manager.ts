import { randomUUID } from 'node:crypto';
import type { Tool, Agent } from '@openai/agents';
import type { ILoggingService, ISettingsService, ISessionContextService } from '../service-interfaces.js';
import type { ExecutionContext } from '../execution-context.js';
import type { SubagentRequest, SubagentResult, SupportedSubagentRole, SubagentDefinition } from './types.js';
import type { ConversationEvent } from '../conversation/conversation-events.js';
import type { ISubagentClient, ISubagentClientFactory } from './subagent-client-types.js';
import { createSubagentRuntime, type SubagentRuntime } from './runtime.js';
import { isAbortLike, safeEmit } from './utils.js';
import { normalizeAgentRunUsage, extractUsage } from '../../utils/ai/token-usage.js';
import type { SubagentRunContext } from './tool-policy.js';
import { adaptLegacyRole, adaptLegacyDefinition } from '../agent-runtime/legacy-adapter.js';
import { createAgentRuntimeFromSubagentRuntime } from '../agent-runtime/compose-agent-runtime.js';
import type { AgentRuntime } from '../agent-runtime/agent-runtime.js';
import type { SkillsService } from '../skills/skills-service.js';

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
    skillsService?: SkillsService;
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

  /**
   * Obtain an AgentRuntime backed by this manager's existing subagent
   * infrastructure (shared tool policy, execution runner, mentor runner).
   * Avoids creating duplicate independent tool policies. The returned
   * runtime's handles execute through the same ExecutionSubagentRunner
   * and MentorRunner used by this manager.
   */
  getAgentRuntime(): AgentRuntime {
    return createAgentRuntimeFromSubagentRuntime({
      settings: this.#settings,
      logger: this.#logger,
      executionRunner: this.#runtime.executionRunner,
      mentorRunner: this.#runtime.mentorRunner,
    });
  }

  /**
   * Resolve a role to a legacy SubagentDefinition through the shared
   * ResolvedAgentDefinition adaptation path. This ensures all role
   * definitions (explorer/worker/researcher/mentor) pass through the
   * same resolution before execution.
   */
  #resolveRoleDefinition(role: string): SubagentDefinition {
    const resolved = adaptLegacyRole(role, this.#settings);
    return adaptLegacyDefinition(resolved);
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
          : await this.#runtime.executionRunner.run(agentId, request, this.#resolveRoleDefinition(request.role));
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
