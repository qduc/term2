import type { ProviderInput, ProviderInputItem } from '../../contracts/provider-input.js';
import type { ISettingsService } from '../service-interfaces.js';
import type { ConversationAgentClient } from '../conversation-agent-client.js';
import type { SessionToolTracker } from './session-tool-tracker.js';
import type { ProviderContinuity } from '../provider-continuity.js';
import type { ProviderHistorySnapshot } from '../conversation/conversation-store.js';
import { InputSurgeGuard, type InputSurgeInputKind, type InputSurgeDecision } from '../input-surge-guard.js';
import {
  getSerializedInputBytes,
  LargeUncachedInputGuard,
  type LargeUncachedInputDecision,
} from '../large-uncached-input-guard.js';
import { getProvider } from '../../providers/index.js';
import { getProfileLabel } from '../profiles/labels.js';
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

/**
 * Byte size of `JSON.stringify([...finalizedHistory, draftItem])` without
 * re-serializing the finalized prefix. Finalized messages never change while
 * the user types, so callers cache `historyBytes`/`historyLength` once per
 * history identity and only re-measure the draft.
 */
export const combineHistoryAndDraftBytes = (
  historyBytes: number,
  historyLength: number,
  draftItemBytes: number,
): number => (historyLength === 0 ? draftItemBytes + 2 : historyBytes + draftItemBytes + 1);

export type SessionInputPlan = {
  streamInput: ProviderInput;
  inputSurgeKind: 'delta' | 'full_history';
  effectiveTurn: UserTurn;
  /** Stage 0 observation only; never used to select or alter wire input. */
  providerHistorySnapshot?: ProviderHistorySnapshot;
};

/** Cached size of the finalized (non-draft) portion of the next outgoing input. */
type OutgoingSizeCache = {
  key: string;
  useChaining: boolean;
  finalizedHistoryBytes: number;
  finalizedHistoryLength: number;
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
  #getProviderHistorySnapshot?: () => ProviderHistorySnapshot;
  /** Cheap history identity — must not clone the transcript. */
  #getHistoryIdentity?: () => string;
  #inputSurgeGuard = new InputSurgeGuard();
  #largeUncachedInputGuard = new LargeUncachedInputGuard();
  #outgoingSizeCache: OutgoingSizeCache | null = null;
  /** Model the most recently dispatched turn was sent to, for detecting a switch. */
  #lastDispatchModel: string | null = null;

  constructor(deps: {
    settingsService?: ISettingsService;
    agentClient: ConversationAgentClient;
    toolTracker: SessionToolTracker;
    providerContinuity: ProviderContinuity;
    getProviderHistorySnapshot?: () => ProviderHistorySnapshot;
    getHistoryIdentity?: () => string;
  }) {
    this.#settingsService = deps.settingsService;
    this.#agentClient = deps.agentClient;
    this.#toolTracker = deps.toolTracker;
    this.#providerContinuity = deps.providerContinuity;
    this.#getProviderHistorySnapshot = deps.getProviderHistorySnapshot;
    this.#getHistoryIdentity = deps.getHistoryIdentity;
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
    this.#outgoingSizeCache = null;
    this.#lastDispatchModel = null;
  }

  /**
   * Records the model the just-built plan was actually dispatched to. The next
   * `build()` call compares this against the then-current model to catch a
   * mid-conversation model switch before it reuses a stale `previous_response_id`.
   *
   * Deliberately not folded into `build()` itself: `build()` must stay pure
   * because `previewInputSurge()` calls it without dispatching anything.
   */
  recordDispatchModel(): void {
    this.#lastDispatchModel = this.#getModelForGuard();
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
        streamInput: statelessHistory as ProviderInputItem[],
        inputSurgeKind: 'full_history',
        effectiveTurn: turn,
        providerHistorySnapshot: this.#getProviderHistorySnapshot?.(),
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
    // Unpaid tool debt means previous_response_id still requires function_call
    // outputs. A text-only delta would 400 ("No tool output found for function
    // call …"). Drop the chain and send self-contained full history instead.
    const hasUnsettledChainDebt = this.#providerContinuity.hasOutstandingToolDebt();
    if (hasUnsettledChainDebt && this.#providerContinuity.previousResponseId) {
      this.#providerContinuity.clear();
    }
    // A held previous_response_id was minted by whatever model produced it.
    // If the user switched models since that turn, the anchor still passes
    // every other chaining check locally but the provider 400s
    // ("Invalid previous_response_id") because the ID does not belong to the
    // model we are about to call. Drop the chain and send full history
    // instead of risking that round trip.
    const currentModel = this.#getModelForGuard();
    const hasModelMismatch =
      this.#lastDispatchModel !== null && currentModel !== null && this.#lastDispatchModel !== currentModel;
    const useChaining =
      supportsChaining &&
      !hasMalformedArgs &&
      !hasUnsettledChainDebt &&
      !hasModelMismatch &&
      this.#providerContinuity.isChainingAvailable(outgoingHistory.length);
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
        : (statelessHistory as ProviderInputItem[]),
      inputSurgeKind: useChaining ? 'delta' : 'full_history',
      effectiveTurn,
      providerHistorySnapshot: this.#getProviderHistorySnapshot?.(),
    };
  }

  /**
   * Preview what the large-uncached-input guard would decide for the given input.
   *
   * Does not mutate any state or consume the pending mode notice.
   *
   * Cost model while typing:
   * 1. Session risk check (`mightWarn`) — free; skips everything when a warn
   *    is impossible (active chat, same config).
   * 2. Finalized history is measured once per history identity and cached —
   *    finalized messages never change while the user types.
   * 3. Each preview only re-sizes the draft turn and combines it with the
   *    cached history bytes (no full-history `JSON.stringify`).
   */
  previewLargeUncachedInput(
    input: string | UserTurn,
    now?: number,
    context?: { pendingModeNotice?: string | null },
  ): LargeUncachedInputDecision {
    const at = now ?? Date.now();
    const riskContext = {
      now: at,
      provider: this.#getProviderForGuard(),
      model: this.#getModelForGuard(),
      reasoningEffort: this.#getReasoningEffortForGuard(),
      mode: this.#getTrafficMode(),
    };
    if (!this.#largeUncachedInputGuard.mightWarn(riskContext)) {
      return {
        action: 'allow',
        warningKey: '',
        reasons: [],
        estimatedTokens: 0,
        estimatedBytes: 0,
      };
    }

    const turn = normalizeUserTurn(input);
    const effectiveTurn = this.#turnWithModeNotice(turn, context?.pendingModeNotice ?? null);
    const { estimatedBytes, contentKey } = this.#estimateOutgoingInputSize(effectiveTurn);
    return this.#largeUncachedInputGuard.inspect({
      estimatedBytes,
      contentKey,
      ...riskContext,
    });
  }

  // ── Private helpers ──────────────────────────────────────────────

  /**
   * Size the next outgoing payload using a cache of the finalized history.
   * Only the draft turn is re-serialized on cache hits.
   */
  #estimateOutgoingInputSize(effectiveTurn: UserTurn): { estimatedBytes: number; contentKey: string } {
    const cache = this.#getOutgoingSizeCache();

    if (cache.useChaining) {
      if (effectiveTurn.images?.length) {
        const item = this.#makeUserInputItem(effectiveTurn);
        // Chained image turns send `[userItem]`, not the bare text.
        const estimatedBytes = getSerializedInputBytes([item]);
        return { estimatedBytes, contentKey: `${cache.key}\nimg:${estimatedBytes}` };
      }
      const text = effectiveTurn.text ?? '';
      const estimatedBytes = getSerializedInputBytes(text);
      return { estimatedBytes, contentKey: `${cache.key}\n${text}` };
    }

    const draftItem = this.#makeUserInputItem(effectiveTurn);
    const draftItemBytes = getSerializedInputBytes(draftItem);
    const estimatedBytes = combineHistoryAndDraftBytes(
      cache.finalizedHistoryBytes,
      cache.finalizedHistoryLength,
      draftItemBytes,
    );
    return {
      estimatedBytes,
      contentKey: `${cache.key}\n${effectiveTurn.text ?? ''}\n${draftItemBytes}`,
    };
  }

  #getOutgoingSizeCache(): OutgoingSizeCache {
    const key = this.#outgoingSizeCacheKey();
    if (this.#outgoingSizeCache?.key === key) {
      return this.#outgoingSizeCache;
    }

    const provider = this.#getProviderForGuard() ?? 'openai';
    const dynamicSupportsChaining = getMethod<[], boolean>(this.#agentClient, 'supportsConversationChaining');
    const supportsChaining = dynamicSupportsChaining
      ? dynamicSupportsChaining.call(this.#agentClient)
      : supportsConversationChaining(provider);
    const history = this.#toolTracker.getReconciledHistory();
    // The draft user turn is never a function_call, so malformed-arg detection
    // on history alone matches build(includeTurn: true).
    const hasMalformedArgs = hasMalformedToolCallArguments(history);
    const useChaining =
      supportsChaining && !hasMalformedArgs && this.#providerContinuity.isChainingAvailable(history.length + 1);

    if (useChaining) {
      this.#outgoingSizeCache = {
        key,
        useChaining: true,
        finalizedHistoryBytes: 0,
        finalizedHistoryLength: 0,
      };
      return this.#outgoingSizeCache;
    }

    const finalizedHistory = sanitizeMalformedToolCallArguments(
      dropUnpairedFunctionCalls(history),
    ) as ProviderInputItem[];
    this.#outgoingSizeCache = {
      key,
      useChaining: false,
      finalizedHistoryBytes: getSerializedInputBytes(finalizedHistory),
      finalizedHistoryLength: finalizedHistory.length,
    };
    return this.#outgoingSizeCache;
  }

  #outgoingSizeCacheKey(): string {
    const historyIdentity =
      this.#getHistoryIdentity?.() ?? this.#getProviderHistorySnapshot?.()?.identity ?? 'unknown-history';
    // Continuity can flip full-history vs delta without a history revision.
    const continuity = `${this.#providerContinuity.previousResponseId ?? ''}:${
      this.#providerContinuity.chainingBroken ? 1 : 0
    }`;
    const provider = this.#getProviderForGuard() ?? '';
    return `${historyIdentity}|${continuity}|${provider}`;
  }

  #getTrafficMode(): string {
    if (!this.#settingsService) return 'standard';
    return getProfileLabel(String(this.#settingsService.get('app.activeProfileId')));
  }

  #getModelForGuard(): string | null {
    return this.#settingsService?.get('agent.model') ?? null;
  }

  #getReasoningEffortForGuard(): string | null {
    return this.#settingsService?.get('agent.reasoningEffort') ?? null;
  }

  #getCurrentProvider(nullable: true): string | null;
  #getCurrentProvider(nullable?: false): string;
  #getCurrentProvider(nullable?: boolean): string | null {
    const fn = getMethod<[], string>(this.#agentClient, 'getProvider');
    const result = fn ? fn.call(this.#agentClient) : this.#settingsService?.get('agent.provider');
    return nullable ? result ?? null : result!;
  }

  #getProviderForGuard(): string | null {
    return this.#getCurrentProvider(true);
  }

  #makeUserInputItem(turn: UserTurn): ProviderInputItem {
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

    return { role: 'user', type: 'message', content };
  }

  #turnWithModeNotice(turn: UserTurn, notice: string | null): UserTurn {
    if (!notice?.trim()) {
      return turn;
    }

    const text = turn.text ? `${notice}\n\n${turn.text}` : notice;
    return { ...turn, text };
  }
}
