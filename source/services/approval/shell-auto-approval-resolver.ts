import type { ILoggingService, ISettingsService, ISessionContextService } from '../service-interfaces.js';
import type { ConversationStore } from '../conversation/conversation-store.js';
import type { LLMAdvisory } from '../../contracts/conversation.js';
import {
  evaluateShellAutoApprovalAdvisories,
  type ShellAutoApprovalManualDecision,
} from './shell-auto-approval-evaluator.js';
import { getCallIdFromObject, getToolInfoFromInterruption } from '../interruption-info.js';
import type { ShellAutoApprovalAgentClient } from '../conversation-agent-client.js';

export type AutoApproveMode = 'off' | 'advisory' | 'auto';

const MAX_TRACKED_MANUAL_DECISIONS = 20;

const parseUnsandboxedFlag = (rawArguments: unknown): boolean => {
  if (typeof rawArguments === 'string') {
    try {
      const parsed = JSON.parse(rawArguments) as { sandbox?: unknown };
      return parsed?.sandbox === 'unsandboxed';
    } catch {
      return false;
    }
  }
  if (!rawArguments || typeof rawArguments !== 'object') return false;
  return (rawArguments as Record<string, unknown>).sandbox === 'unsandboxed';
};

export interface ShellAutoApprovalResolverDeps {
  conversationStore: ConversationStore;
  agentClient: ShellAutoApprovalAgentClient;
  logger: ILoggingService;
  settingsService?: ISettingsService;
  sessionContextService: ISessionContextService;
}

export class ShellAutoApprovalResolver {
  private advisoriesByCallId = new Map<string, LLMAdvisory>();
  private manualDecisions: ShellAutoApprovalManualDecision[] = [];

  constructor(private readonly deps: ShellAutoApprovalResolverDeps) {}

  /** Records a human approve/reject decision on a shell command, offered as precedent for later evaluations. */
  recordManualDecision(command: string, decision: 'approved' | 'rejected'): void {
    this.manualDecisions.push({ command, decision });
    if (this.manualDecisions.length > MAX_TRACKED_MANUAL_DECISIONS) {
      this.manualDecisions.shift();
    }
  }

  getAutoApproveMode(): AutoApproveMode | undefined {
    return this.deps.settingsService?.get('shell.autoApproveMode');
  }

  /**
   * Whether an unsandboxed shell request may be evaluated by the LLM
   * auto-approval path instead of being forced to a human prompt. Requires the
   * sandbox to be enabled (escape is meaningful) and auto-approval mode to be
   * advisory or auto. Read per call so mid-session setting toggles apply
   * immediately.
   */
  isUnsandboxedApprovalEligible(): boolean {
    const mode = this.getAutoApproveMode();
    const sandboxEnabled = this.deps.settingsService?.get('sandbox.enabled') !== false;
    return sandboxEnabled && (mode === 'advisory' || mode === 'auto');
  }

  shouldAutoApprove(advisory: LLMAdvisory | undefined): boolean {
    return this.getAutoApproveMode() === 'auto' && advisory?.approved === true && advisory.source === 'llm';
  }

  async resolveAdvisoryForInterruption(input: {
    interruption: unknown;
    siblings: unknown[];
  }): Promise<LLMAdvisory | undefined> {
    const { interruption, siblings } = input;
    const { toolName, argumentsText, rawArguments } = getToolInfoFromInterruption(interruption);
    if (toolName !== 'shell' && toolName !== 'bash') {
      return undefined;
    }

    const callId = getCallIdFromObject(interruption);

    const shellCommands = siblings
      .map((i) => {
        const info = getToolInfoFromInterruption(i);
        const id = getCallIdFromObject(i);
        return {
          id,
          command: info.argumentsText,
          toolName: info.toolName,
          unsandboxed: parseUnsandboxedFlag(info.rawArguments),
        };
      })
      .filter(
        (info): info is { id: string; command: string; toolName: string; unsandboxed: boolean } =>
          !!info.id && (info.toolName === 'shell' || info.toolName === 'bash'),
      );

    const unevaluated = shellCommands.filter((c) => !this.advisoriesByCallId.has(c.id));
    if (unevaluated.length > 0) {
      const results = await evaluateShellAutoApprovalAdvisories({
        commands: unevaluated.map(({ id, command, unsandboxed }) => ({
          id,
          command,
          ...(unsandboxed ? { unsandboxed: true } : {}),
        })),
        history: this.deps.conversationStore.getHistory(),
        manualDecisions: this.manualDecisions,
        settingsService: this.deps.settingsService,
        agentClient: this.deps.agentClient,
        logger: this.deps.logger,
        sessionContextService: this.deps.sessionContextService,
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
      commands: [
        {
          id: '__single__',
          command: argumentsText,
          ...(parseUnsandboxedFlag(rawArguments) ? { unsandboxed: true } : {}),
        },
      ],
      history: this.deps.conversationStore.getHistory(),
      manualDecisions: this.manualDecisions,
      settingsService: this.deps.settingsService,
      agentClient: this.deps.agentClient,
      logger: this.deps.logger,
      sessionContextService: this.deps.sessionContextService,
    });
    return single.get('__single__');
  }

  clearCache(): void {
    this.advisoriesByCallId.clear();
  }
}

export class DelegatingShellAutoApprovalResolver extends ShellAutoApprovalResolver {
  private delegate?: ShellAutoApprovalResolver;

  constructor(deps: ShellAutoApprovalResolverDeps) {
    super(deps);
  }

  setDelegate(delegate: ShellAutoApprovalResolver): void {
    this.delegate = delegate;
  }

  override getAutoApproveMode(): AutoApproveMode | undefined {
    return this.delegate ? this.delegate.getAutoApproveMode() : super.getAutoApproveMode();
  }

  override isUnsandboxedApprovalEligible(): boolean {
    return this.delegate ? this.delegate.isUnsandboxedApprovalEligible() : super.isUnsandboxedApprovalEligible();
  }

  override shouldAutoApprove(advisory: LLMAdvisory | undefined): boolean {
    return this.delegate ? this.delegate.shouldAutoApprove(advisory) : super.shouldAutoApprove(advisory);
  }

  override async resolveAdvisoryForInterruption(input: {
    interruption: unknown;
    siblings: unknown[];
  }): Promise<LLMAdvisory | undefined> {
    return this.delegate
      ? this.delegate.resolveAdvisoryForInterruption(input)
      : super.resolveAdvisoryForInterruption(input);
  }

  override recordManualDecision(command: string, decision: 'approved' | 'rejected'): void {
    if (this.delegate) {
      this.delegate.recordManualDecision(command, decision);
    } else {
      super.recordManualDecision(command, decision);
    }
  }

  override clearCache(): void {
    if (this.delegate) {
      this.delegate.clearCache();
    } else {
      super.clearCache();
    }
  }
}
