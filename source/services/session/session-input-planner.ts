import type { AgentInputItem } from '@openai/agents';
import type { ISettingsService } from '../service-interfaces.js';
import type { ConversationAgentClient } from '../conversation-agent-client.js';
import type { SessionToolTracker } from './session-tool-tracker.js';
import type { ProviderContinuity } from '../provider-continuity.js';
import { InputSurgeGuard, type InputSurgeInputKind, type InputSurgeDecision } from '../input-surge-guard.js';
import { LargeUncachedInputGuard, type LargeUncachedInputDecision } from '../large-uncached-input-guard.js';
import { getProvider } from '../../providers/index.js';
import { getMethod } from '../interruption-info.js';
import { normalizeUserTurn, type UserTurn } from '../../types/user-turn.js';
import {
  dropUnpairedFunctionCalls,
  hasMalformedToolCallArguments,
  sanitizeMalformedToolCallArguments,
} from '../tool-execution-ledger.js';

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
  #providerContinuity: ProviderContinuity;
  #inputSurgeGuard = new InputSurgeGuard();
  #largeUncachedInputGuard = new LargeUncachedInputGuard();

  constructor(deps: {
    settingsService?: ISettingsService;
    agentClient: ConversationAgentClient;
    toolTracker: SessionToolTracker;
    providerContinuity: ProviderContinuity;
  }) {
    this.#settingsService = deps.settingsService;
    this.#agentClient = deps.agentClient;
    this.#toolTracker = deps.toolTracker;
    this.#providerContinuity = deps.providerContinuity;
  }

  /**
   * Inspect the input for a potential input surge condition.
   * Used by the session after building a plan to decide whether to block.
   */
  inspectForSurge(input: unknown, kind: InputSurgeInputKind): InputSurgeDecision {
    return this.#inputSurgeGuard.inspect(input, { kind });
  }

  /**
   * Preview what the input surge guard would decide for the given input.
   *
   * Does not mutate any state or consume the pending mode notice.
   */
  previewInputSurge(input: string | UserTurn, context?: { pendingModeNotice?: string | null }): InputSurgeDecision {
    const turn = normalizeUserTurn(input);
    const { streamInput, inputSurgeKind } = this.build(turn, {
      includeTurn: true,
      pendingModeNotice: context?.pendingModeNotice ?? null,
    });
    return this.#inputSurgeGuard.inspect(streamInput, { kind: inputSurgeKind, preview: true });
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
   * Seed the input surge guard baseline for testing.
   */
  seedInputSurgeBaseline(data: unknown[], kind: 'delta' | 'full_history'): void {
    this.recordSuccess(data, { kind, previousInput: undefined });
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
  build(
    turn: UserTurn,
    options: { includeTurn: boolean; pendingModeNotice: string | null; replayFromHistory?: boolean },
  ): SessionInputPlan {
    const provider = this.#getProviderForGuard() ?? 'openai';
    const dynamicSupportsChaining = getMethod<[], boolean>(this.#agentClient, 'supportsConversationChaining');
    const supportsChaining = dynamicSupportsChaining
      ? dynamicSupportsChaining.call(this.#agentClient)
      : supportsConversationChaining(provider);
    const history = this.#toolTracker.getReconciledHistory();
    if (options.replayFromHistory) {
      const statelessHistory = sanitizeMalformedToolCallArguments(dropUnpairedFunctionCalls(history));
      return {
        streamInput: statelessHistory as AgentInputItem[],
        inputSurgeKind: 'full_history',
        effectiveTurn: turn,
      };
    }
    const effectiveTurn = options.includeTurn ? this.#turnWithModeNotice(turn, options.pendingModeNotice) : turn;
    const outgoingHistory = options.includeTurn ? [...history, this.#makeUserInputItem(effectiveTurn)] : history;
    // When the history contains a function_call with malformed JSON arguments
    // (e.g. from a stream interrupted mid-response), provider-side chaining is
    // unreliable — the previous response may carry the malformed tool call.
    // Fall back to stateless mode where the arguments can be sanitized before
    // sending.
    const hasMalformedArgs = hasMalformedToolCallArguments(outgoingHistory);
    const useChaining =
      supportsChaining && !hasMalformedArgs && this.#providerContinuity.isChainingAvailable(outgoingHistory.length);
    const latestInput = outgoingHistory[outgoingHistory.length - 1] ?? effectiveTurn.text;
    const chainedInput = effectiveTurn.images?.length ? latestInput : effectiveTurn.text;

    // Stateless (full-history) inputs must be self-contained: the Responses
    // API rejects a previous_response_id-less input containing a function_call
    // without a paired output. Recovery may fail to find every in-flight tool
    // output (lost deltas), so drop orphaned calls as a last-resort safety net.
    // Malformed JSON arguments (from interrupted streams) are also repaired so
    // the provider API accepts the request.
    const statelessHistory = useChaining
      ? null
      : sanitizeMalformedToolCallArguments(dropUnpairedFunctionCalls(outgoingHistory));

    return {
      streamInput: useChaining
        ? typeof chainedInput === 'string'
          ? chainedInput
          : [chainedInput]
        : (statelessHistory as AgentInputItem[]),
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
