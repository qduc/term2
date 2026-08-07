import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ApplicationRunLoop, type ApplicationAgent } from '../agent-runtime/application-run-loop.js';
import type { ILoggingService, ISettingsService, ISessionContextService } from '../service-interfaces.js';
import type { ExecutionContext } from '../execution-context.js';
import type { SubagentResult } from './types.js';
import { SubagentSession } from './subagent-session.js';
import { loadRoleDefinition, resolvePrompt, PROMPTS_DIR } from './role-loader.js';
import { getEnvInfo, getAgentsInstructions } from '../../agent.js';
import { getProvider } from '../../providers/index.js';
import { extractFinalText, isAbortLike } from './utils.js';
import { selectAgentStreamItems } from '../agent-stream.js';
import { normalizeAgentRunUsage, extractUsage } from '../../utils/ai/token-usage.js';
import type { ModelRequestCost } from '../../services/cost/model-cost.js';
import type { ConversationEvent } from '../conversation/conversation-events.js';
import { AcquiredChildSlot } from '../agent-runtime/execution-budget.js';
import type { ExecutionBudget } from '../agent-runtime/execution-budget.js';

export class MentorRunner {
  #logger: ILoggingService;
  #settings: ISettingsService;
  #sessionContextService: ISessionContextService;
  #executionContext?: ExecutionContext;
  #mentorSession: SubagentSession;

  constructor(deps: {
    logger: ILoggingService;
    settings: ISettingsService;
    sessionContextService: ISessionContextService;
    executionContext?: ExecutionContext;
    onEvent?: (event: ConversationEvent) => void;
    session?: SubagentSession;
  }) {
    this.#logger = deps.logger;
    this.#settings = deps.settings;
    this.#sessionContextService = deps.sessionContextService;
    this.#executionContext = deps.executionContext;
    this.#mentorSession = deps.session ?? new SubagentSession(randomUUID(), 'mentor');
  }

  reset(): void {
    this.#mentorSession.reset();
  }

  async run(
    agentId: string,
    task: string,
    signal?: AbortSignal,
    session?: SubagentSession,
    executionBudget?: ExecutionBudget,
  ): Promise<SubagentResult> {
    let slot: AcquiredChildSlot | undefined;
    let childBudget = executionBudget;
    if (executionBudget) {
      childBudget = executionBudget.createChildBudget();
      const acquired = executionBudget.tryAcquireChild();
      if (!(acquired instanceof AcquiredChildSlot)) {
        return {
          agentId,
          role: 'mentor',
          status: 'failed',
          finalText: '',
          filesChanged: [],
          toolsUsed: [],
          error: `Budget exhausted: ${acquired.reason}${
            acquired.max !== undefined ? ` (${acquired.current}/${acquired.max})` : ''
          }`,
        };
      }
      slot = acquired;
    }
    const previousSession = this.#mentorSession;
    if (session) this.#mentorSession = session;
    try {
      try {
        const result = await this.#runWithSession(agentId, task, signal);
        if (slot && result.usage) childBudget!.recordUsage(result.usage);
        return result;
      } catch (error: any) {
        if (!signal?.aborted && !isAbortLike(error?.message, error)) throw error;
        const usage = normalizeAgentRunUsage(error?.usage) ?? extractUsage(error);
        if (slot && usage) childBudget!.recordUsage(usage);
        return {
          agentId,
          role: 'mentor',
          status: 'cancelled',
          finalText: '',
          filesChanged: [],
          toolsUsed: [],
          error: error?.message ?? 'The subagent run was aborted.',
          ...(usage ? { usage } : {}),
        };
      }
    } finally {
      slot?.release();
      if (session) this.#mentorSession = previousSession;
    }
  }

  async runInSession(
    agentId: string,
    task: string,
    signal: AbortSignal | undefined,
    session: SubagentSession,
  ): Promise<SubagentResult> {
    return this.run(agentId, task, signal, session, undefined);
  }

  async #runWithSession(agentId: string, task: string, signal?: AbortSignal): Promise<SubagentResult> {
    const definition = loadRoleDefinition('mentor', this.#settings);
    const mentorModelName = definition.model;
    const mentorProvider = definition.provider;
    const mentorMode = this.#settings.get('app.mentorMode');

    const baseInstructions = mentorMode
      ? resolvePrompt(path.join(PROMPTS_DIR, 'mentor-mode.md'))
      : definition.instructions;

    const envInfo = getEnvInfo(this.#settings, this.#executionContext);
    const cwd = this.#executionContext?.getCwd() ?? process.cwd();
    const agentsInstructions = this.#executionContext?.isRemote() ? '' : getAgentsInstructions(cwd);
    const instructions = `${baseInstructions}\n\nEnvironment: ${envInfo}${agentsInstructions}`;

    this.#mentorSession.switchProvider(mentorProvider);

    const providerDef = getProvider(mentorProvider);
    if (!providerDef?.createStreamedModel) {
      const providerLabel = providerDef?.label || mentorProvider;
      throw new Error(
        `${providerLabel} is configured but could not be initialized. ` +
          `Please check that all required credentials and provider settings are set.`,
      );
    }
    const streamedModel = await this.#mentorSession.ensureModel(mentorProvider, (providerId) => {
      const definition = getProvider(providerId);
      if (!definition?.createStreamedModel) throw new Error(`${providerId} has no streamed model`);
      return definition.createStreamedModel(mentorModelName, {
        settingsService: this.#settings,
        loggingService: this.#logger,
        sessionContextService: this.#sessionContextService,
      });
    });
    if (!streamedModel)
      throw new Error(`${providerDef.label || mentorProvider} is configured but could not be initialized.`);

    const mentorAgent = this.#mentorSession.ensureAgent(() => {
      const reasoningEffort = this.#settings.get('agent.mentorReasoningEffort');
      const modelSettings: any = {
        retry: { maxRetries: this.#settings.get('agent.retryAttempts') ?? 2 },
      };
      if (reasoningEffort && reasoningEffort !== 'default') {
        modelSettings.reasoning = { effort: reasoningEffort, summary: 'auto' };
      }

      return {
        name: definition.name,
        model: mentorModelName,
        ...(Object.keys(modelSettings).length > 0 ? { modelSettings } : {}),
        instructions,
        tools: [],
      } satisfies ApplicationAgent;
    }) as ApplicationAgent;

    this.#mentorSession.addUserMessage(task);

    const supportsChaining = providerDef.capabilities?.supportsConversationChaining ?? false;
    const input = this.#mentorSession.getInput(task, supportsChaining);
    const loop = new ApplicationRunLoop({ resolveModel: () => streamedModel });
    const stream = loop.startStream(mentorAgent, input, {
      ...(signal ? { signal } : {}),
      maxTurns: definition.maxTurns,
      ...(supportsChaining && this.#mentorSession.previousResponseId
        ? { previousResponseId: this.#mentorSession.previousResponseId }
        : {}),
    });
    try {
      await stream.completed;
    } catch (error: any) {
      if (stream.runUsage !== undefined) error.usage = stream.runUsage;
      throw error;
    }
    this.#mentorSession.appendOutput({ output: selectAgentStreamItems(stream), lastResponseId: stream.lastResponseId });

    return {
      agentId,
      role: 'mentor',
      status: 'completed',
      finalText: extractFinalText(stream),
      filesChanged: [],
      toolsUsed: [],
      usage: normalizeAgentRunUsage(stream.runUsage) ?? extractUsage(stream),
      costRecords: stream.runCostRecords as ModelRequestCost[] | undefined,
    };
  }
}
