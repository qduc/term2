import path from 'node:path';
import { Agent } from '@openai/agents';
import { randomUUID } from 'node:crypto';
import type { ILoggingService, ISettingsService, ISessionContextService } from '../service-interfaces.js';
import type { ExecutionContext } from '../execution-context.js';
import type { SubagentResult } from './types.js';
import { SubagentSession } from './subagent-session.js';
import { loadRoleDefinition, resolvePrompt, PROMPTS_DIR } from './role-loader.js';
import { getEnvInfo, getAgentsInstructions } from '../../agent.js';
import { getProvider } from '../../providers/index.js';
import { runWithProvider, extractFinalText } from './utils.js';
import { normalizeAgentRunUsage, extractUsage } from '../../utils/ai/token-usage.js';
import type { ConversationEvent } from '../conversation/conversation-events.js';

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
  }) {
    this.#logger = deps.logger;
    this.#settings = deps.settings;
    this.#sessionContextService = deps.sessionContextService;
    this.#executionContext = deps.executionContext;
    this.#mentorSession = new SubagentSession(randomUUID(), 'mentor');
  }

  reset(): void {
    this.#mentorSession.reset();
  }

  async run(agentId: string, task: string, signal?: AbortSignal): Promise<SubagentResult> {
    const mentorModel = this.#settings.get<string>('agent.mentorModel');
    if (!mentorModel) {
      throw new Error('Mentor model is not configured');
    }

    const mentorProvider =
      this.#settings.get<string>('agent.mentorProvider') ?? this.#settings.get<string>('agent.provider') ?? 'openai';
    const mentorMode = this.#settings.get<boolean>('app.mentorMode');

    const definition = loadRoleDefinition('mentor', this.#settings);

    const baseInstructions = mentorMode
      ? resolvePrompt(path.join(PROMPTS_DIR, 'mentor-mode.md'))
      : definition.instructions;

    const envInfo = getEnvInfo(this.#settings, this.#executionContext);
    const cwd = this.#executionContext?.getCwd() ?? process.cwd();
    const agentsInstructions = this.#executionContext?.isRemote() ? '' : getAgentsInstructions(cwd);
    const instructions = `${baseInstructions}\n\nEnvironment: ${envInfo}${agentsInstructions}`;

    this.#mentorSession.switchProvider(mentorProvider);

    const mentorRunner = this.#mentorSession.ensureRunner(mentorProvider, (providerId) => {
      const providerDef = getProvider(providerId);
      return (
        providerDef?.createRunner?.({
          settingsService: this.#settings,
          loggingService: this.#logger,
          sessionContextService: this.#sessionContextService,
        }) ?? null
      );
    });

    const mentorAgent = this.#mentorSession.ensureAgent(() => {
      const reasoningEffort = this.#settings.get<string>('agent.mentorReasoningEffort');
      const modelSettings: any = {
        retry: { maxRetries: 0 },
      };
      if (reasoningEffort && reasoningEffort !== 'default') {
        modelSettings.reasoning = { effort: reasoningEffort, summary: 'auto' };
      }

      return new Agent({
        name: definition.name,
        model: mentorModel,
        ...(Object.keys(modelSettings).length > 0 ? { modelSettings } : {}),
        instructions,
      });
    });

    this.#mentorSession.addUserMessage(task);

    const providerDef = getProvider(mentorProvider);
    const supportsChaining = providerDef?.capabilities?.supportsConversationChaining ?? false;
    const input = this.#mentorSession.getInput(task, supportsChaining);
    const subagentContext = {
      turnCount: 0,
      maxTurns: definition.maxTurns,
    };
    const runOptions = {
      ...this.#mentorSession.getRunOptions(supportsChaining, definition.maxTurns),
      context: subagentContext,
      callModelInputFilter: (args: any) => {
        if (args.context) {
          args.context.turnCount = (args.context.turnCount ?? 0) + 1;
        }
        return args.modelData;
      },
      ...(signal ? { signal } : {}),
    };

    const result = await runWithProvider(mentorProvider, mentorRunner, mentorAgent, input, runOptions);
    this.#mentorSession.appendOutput(result);

    return {
      agentId,
      role: 'mentor',
      status: 'completed',
      finalText: extractFinalText(result),
      filesChanged: [],
      toolsUsed: [],
      usage: normalizeAgentRunUsage(result?.state?.usage) ?? extractUsage(result),
    };
  }
}
