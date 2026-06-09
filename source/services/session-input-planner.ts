import type { AgentInputItem } from '@openai/agents';
import type { ISettingsService } from './service-interfaces.js';
import type { ConversationAgentClient } from './conversation-agent-client.js';
import type { SessionToolTracker } from './session-tool-tracker.js';
import type { SessionRetryOrchestrator } from './session-retry-orchestrator.js';
import { InputSurgeGuard, type InputSurgeInputKind, type InputSurgeDecision } from './input-surge-guard.js';
import { LargeUncachedInputGuard, type LargeUncachedInputDecision } from './large-uncached-input-guard.js';
import { getProvider } from '../providers/index.js';
import { getMethod } from './interruption-info.js';
import { normalizeUserTurn, type UserTurn } from '../types/user-turn.js';

const supportsConversationChaining = (providerId: string): boolean => {
  const providerDef = getProvider(providerId);
  return providerDef?.capabilities?.supportsConversationChaining ?? false;
};

export type SessionInputPlan = {
  streamInput: string | AgentInputItem | AgentInputItem[];
  inputSurgeKind: 'delta' | 'full_history';
  effectiveTurn: UserTurn;
};

/**
 * Owns all input construction and guard logic for a conversation session.
 *
 * Decides what to send to the provider (delta vs full history, chaining vs not),
 * handles mode-notice prepending, image-aware user-input items, provider
 * capability queries, large-uncached-input previews, and input surge guard
 * recording.
 *
 * `ConversationSession` asks this object for an input plan instead of knowing
 * how chaining, full-history mode, images, provider capability, and large-input
 * guards work.
 */
export class SessionInputPlanner {
  #settingsService?: ISettingsService;
  #agentClient: ConversationAgentClient;
  #toolTracker: SessionToolTracker;
  #retryOrchestrator: SessionRetryOrchestrator;
  #inputSurgeGuard = new InputSurgeGuard();
  #largeUncachedInputGuard = new LargeUncachedInputGuard();
  #previousResponseId: string | null = null;

  constructor(deps: {
    settingsService?: ISettingsService;
    agentClient: ConversationAgentClient;
    toolTracker: SessionToolTracker;
    retryOrchestrator: SessionRetryOrchestrator;
  }) {
    this.#settingsService = deps.settingsService;
    this.#agentClient = deps.agentClient;
    this.#toolTracker = deps.toolTracker;
    this.#retryOrchestrator = deps.retryOrchestrator;
  }

  /**
   * Update the stored previous-response-id after a stream finalizes.
   * The session calls this when it would normally set its own previousResponseId.
   */
  set previousResponseId(id: string | null) {
    this.#previousResponseId = id;
  }

  /**
   * Inspect the input for a potential input surge condition.
   * Used by the session after building a plan to decide whether to block.
   */
  inspectForSurge(input: unknown, kind: InputSurgeInputKind): InputSurgeDecision {
    return this.#inputSurgeGuard.inspect(input, { kind });
  }

  /**
   * Record a successful input delivery for both surge and uncached-input guards.
   */
  recordSuccess(input: unknown, options: { kind: 'delta' | 'full_history'; previousInput?: unknown }): void {
    this.#inputSurgeGuard.recordSuccessfulInput(input, options);
    this.#largeUncachedInputGuard.recordSuccessfulInput({
      input,
      now: Date.now(),
      provider: this.#getProviderForGuard(),
      model: this.#getModelForGuard(),
      reasoningEffort: this.#getReasoningEffortForGuard(),
      mode: this.#getTrafficMode(),
    });
  }

  /**
   * Reset both surge and uncached-input guards (e.g. after undo or import).
   */
  reset(): void {
    this.#inputSurgeGuard.reset();
    this.#largeUncachedInputGuard.reset();
  }

  /**
   * Mark a resumed session on the large-uncached-input guard.
   */
  markResumedSession(options: { updatedAtMs: number | null }): void {
    this.#largeUncachedInputGuard.markResumedSession(options);
  }

  /**
   * Mark an undo/rewind on the large-uncached-input guard.
   */
  markUndoOrRewind(): void {
    this.#largeUncachedInputGuard.markUndoOrRewind();
  }

  /**
   * Build an input plan for the given user turn.
   *
   * @param turn - The user turn to build input for (already normalized by the session).
   * @param options.includeTurn - Whether to include the turn in the outgoing history.
   *   When `true` the turn is appended to the reconciled history as a user-input item.
   *   When `false` only the reconciled history is used (the turn is already in the store).
   * @param options.pendingModeNotice - An optional mode notice to prepend to the turn text.
   * @returns A plan describing what to send to the provider.
   */
  build(turn: UserTurn, options: { includeTurn: boolean; pendingModeNotice: string | null }): SessionInputPlan {
    const provider = this.#getProviderForGuard() ?? 'openai';
    const supportsChaining = supportsConversationChaining(provider);
    const history = this.#toolTracker.getReconciledHistory();
    const effectiveTurn = options.includeTurn ? this.#turnWithModeNotice(turn, options.pendingModeNotice) : turn;
    const outgoingHistory = options.includeTurn ? [...history, this.#makeUserInputItem(effectiveTurn)] : history;
    const useChaining =
      supportsChaining &&
      !this.#retryOrchestrator.chainingBrokenState &&
      (!!this.#previousResponseId || outgoingHistory.length <= 1);
    const latestInput = outgoingHistory[outgoingHistory.length - 1] ?? effectiveTurn.text;
    const chainedInput = effectiveTurn.images?.length ? latestInput : effectiveTurn.text;

    return {
      streamInput: useChaining ? (typeof chainedInput === 'string' ? chainedInput : [chainedInput]) : outgoingHistory,
      inputSurgeKind: useChaining ? 'delta' : 'full_history',
      effectiveTurn,
    };
  }

  /**
   * Preview what the large-uncached-input guard would decide for the given input.
   *
   * Does not mutate any state or consume the pending mode notice.
   */
  previewLargeUncachedInput(
    input: string | UserTurn,
    now?: number,
    context?: { pendingModeNotice?: string | null },
  ): LargeUncachedInputDecision {
    const turn = normalizeUserTurn(input);
    const { streamInput } = this.build(turn, {
      includeTurn: true,
      pendingModeNotice: context?.pendingModeNotice ?? null,
    });
    return this.#largeUncachedInputGuard.inspect({
      input: streamInput,
      now: now ?? Date.now(),
      provider: this.#getProviderForGuard(),
      model: this.#getModelForGuard(),
      reasoningEffort: this.#getReasoningEffortForGuard(),
      mode: this.#getTrafficMode(),
    });
  }

  // ── Private helpers ──────────────────────────────────────────────

  #getTrafficMode(): string {
    if (!this.#settingsService) return 'standard';
    if (this.#settingsService.get<boolean>('app.orchestratorMode')) return 'orchestrator';
    if (this.#settingsService.get<boolean>('app.liteMode')) return 'lite';
    if (this.#settingsService.get<boolean>('app.planMode')) return 'plan';
    if (this.#settingsService.get<boolean>('app.mentorMode')) return 'mentor';
    return 'standard';
  }

  #getModelForGuard(): string | null {
    return this.#settingsService?.get<string>('agent.model') ?? null;
  }

  #getReasoningEffortForGuard(): string | null {
    return this.#settingsService?.get<string>('agent.reasoningEffort') ?? null;
  }

  #getCurrentProvider(nullable: true): string | null;
  #getCurrentProvider(nullable?: false): string;
  #getCurrentProvider(nullable?: boolean): string | null {
    const fn = getMethod<[], string>(this.#agentClient, 'getProvider');
    const result = fn ? fn.call(this.#agentClient) : this.#settingsService?.get<string>('agent.provider');
    return nullable ? result ?? null : result!;
  }

  #getProviderForGuard(): string | null {
    return this.#getCurrentProvider(true);
  }

  #makeUserInputItem(turn: UserTurn): AgentInputItem {
    const images = turn.images ?? [];
    if (images.length === 0) {
      return { role: 'user', type: 'message', content: turn.text ?? '' };
    }

    const content: any[] = [];
    if (turn.text) {
      content.push({ type: 'input_text', text: turn.text });
    }
    for (const image of images) {
      content.push({
        type: 'input_image',
        image: `data:${image.mimeType};base64,${image.data}`,
        detail: 'auto',
      });
    }

    return { role: 'user', type: 'message', content } as AgentInputItem;
  }

  #turnWithModeNotice(turn: UserTurn, notice: string | null): UserTurn {
    if (!notice?.trim()) {
      return turn;
    }

    const text = turn.text ? `${notice}\n\n${turn.text}` : notice;
    return { ...turn, text };
  }
}
