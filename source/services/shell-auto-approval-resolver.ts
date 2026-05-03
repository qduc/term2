import type { OpenAIAgentClient } from '../lib/openai-agent-client.js';
import type { ILoggingService, ISettingsService } from './service-interfaces.js';
import type { ConversationStore } from './conversation-store.js';
import type { LLMAdvisory } from '../contracts/conversation.js';
import { evaluateShellAutoApprovalAdvisories } from './shell-auto-approval-evaluator.js';
import { getCallIdFromObject, getToolInfoFromInterruption } from './interruption-info.js';

export type AutoApproveMode = 'off' | 'advisory' | 'auto';

export interface ShellAutoApprovalResolverDeps {
  conversationStore: ConversationStore;
  agentClient: OpenAIAgentClient;
  logger: ILoggingService;
  settingsService?: ISettingsService;
}

export class ShellAutoApprovalResolver {
  private advisoriesByCallId = new Map<string, LLMAdvisory>();

  constructor(private readonly deps: ShellAutoApprovalResolverDeps) {}

  getAutoApproveMode(): AutoApproveMode | undefined {
    return this.deps.settingsService?.get<AutoApproveMode>('shell.autoApproveMode');
  }

  shouldAutoApprove(advisory: LLMAdvisory | undefined): boolean {
    return this.getAutoApproveMode() === 'auto' && advisory?.approved === true && advisory.source === 'llm';
  }

  async resolveAdvisoryForInterruption(input: {
    interruption: unknown;
    siblings: unknown[];
  }): Promise<LLMAdvisory | undefined> {
    const { interruption, siblings } = input;
    const { toolName, argumentsText } = getToolInfoFromInterruption(interruption);
    if (toolName !== 'shell' && toolName !== 'bash') {
      return undefined;
    }

    const callId = getCallIdFromObject(interruption);

    const shellCommands = siblings
      .map((i) => {
        const info = getToolInfoFromInterruption(i);
        const id = getCallIdFromObject(i);
        return { id, command: info.argumentsText, toolName: info.toolName };
      })
      .filter(
        (info): info is { id: string; command: string; toolName: string } =>
          !!info.id && (info.toolName === 'shell' || info.toolName === 'bash'),
      );

    const unevaluated = shellCommands.filter((c) => !this.advisoriesByCallId.has(c.id));
    if (unevaluated.length > 0) {
      const results = await evaluateShellAutoApprovalAdvisories({
        commands: unevaluated.map(({ id, command }) => ({ id, command })),
        history: this.deps.conversationStore.getHistory(),
        settingsService: this.deps.settingsService,
        agentClient: this.deps.agentClient,
        logger: this.deps.logger,
      });
      for (const [id, advisory] of results) {
        this.advisoriesByCallId.set(id, advisory);
      }
    }

    if (callId) {
      return this.advisoriesByCallId.get(callId);
    }

    // No callId: evaluate this single command inline without caching.
    const single = await evaluateShellAutoApprovalAdvisories({
      commands: [{ id: '__single__', command: argumentsText }],
      history: this.deps.conversationStore.getHistory(),
      settingsService: this.deps.settingsService,
      agentClient: this.deps.agentClient,
      logger: this.deps.logger,
    });
    return single.get('__single__');
  }

  clearCache(): void {
    this.advisoriesByCallId.clear();
  }
}
