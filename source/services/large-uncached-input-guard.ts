import crypto from 'crypto';

export interface LargeUncachedInputGuardConfig {
  enabled: boolean;
  largePromptTokenThreshold: number;
  idleMs: number;
}

export type LargeUncachedInputWarningReason =
  | 'provider_changed'
  | 'model_changed'
  | 'reasoning_effort_changed'
  | 'mode_changed'
  | 'resumed_session_stale'
  | 'resumed_session_unknown_age'
  | 'idle_timeout'
  | 'undo_rewind';

export interface LargeUncachedInputContext {
  /**
   * Outgoing provider input. Optional when `estimatedBytes` is supplied — the
   * composer path sizes finalized history once and only re-estimates the draft.
   */
  input?: unknown;
  /**
   * Precomputed payload size. When set, `inspect` skips `JSON.stringify` of
   * `input` (which is O(conversation) for full-history sends).
   */
  estimatedBytes?: number;
  /**
   * Stable material for `warningKey` when sizing without serializing `input`
   * (e.g. history identity + draft text).
   */
  contentKey?: string;
  now: number;
  provider?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
  mode?: string | null;
}

/** Context fields needed to know whether a warning *could* fire, without the payload. */
export type LargeUncachedInputRiskContext = Omit<LargeUncachedInputContext, 'input'>;

export interface LargeUncachedInputDecision {
  action: 'allow' | 'warn';
  warningKey: string;
  reasons: LargeUncachedInputWarningReason[];
  estimatedTokens: number;
  estimatedBytes: number;
}

interface SuccessfulSendState {
  provider?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
  mode?: string | null;
  completedAt: number;
}

export const DEFAULT_LARGE_UNCACHED_INPUT_GUARD_CONFIG: LargeUncachedInputGuardConfig = {
  enabled: true,
  largePromptTokenThreshold: 64_000,
  idleMs: 5 * 60 * 1_000,
};

const serializeInput = (input: unknown): string => {
  try {
    return JSON.stringify(input) ?? String(input);
  } catch {
    return String(input);
  }
};

export const getSerializedInputBytes = (input: unknown): number => {
  return Buffer.byteLength(serializeInput(input));
};

const estimateTokens = (bytes: number): number => Math.ceil(bytes / 4);

const warningKeyFor = (
  serializedInput: string,
  reasons: LargeUncachedInputWarningReason[],
  context: Pick<LargeUncachedInputContext, 'provider' | 'model' | 'reasoningEffort' | 'mode'>,
): string => {
  const hash = crypto.createHash('sha256');
  hash.update(serializedInput);
  hash.update('\n');
  hash.update([...reasons].sort().join(','));
  hash.update('\n');
  hash.update(
    JSON.stringify({
      provider: context.provider ?? null,
      model: context.model ?? null,
      reasoningEffort: context.reasoningEffort ?? null,
      mode: context.mode ?? null,
    }),
  );
  return hash.digest('hex').slice(0, 24);
};

const isNonLiteModeTransition = (fromMode?: string | null, toMode?: string | null): boolean => {
  const nonLiteModes = new Set(['standard', 'plan', 'mentor', 'orchestrator']);
  return nonLiteModes.has(fromMode ?? 'standard') && nonLiteModes.has(toMode ?? 'standard');
};

const allowDecision = (estimatedTokens = 0, estimatedBytes = 0): LargeUncachedInputDecision => ({
  action: 'allow',
  warningKey: '',
  reasons: [],
  estimatedTokens,
  estimatedBytes,
});

export class LargeUncachedInputGuard {
  #config: LargeUncachedInputGuardConfig;
  #lastSuccessful: SuccessfulSendState | null = null;
  #resumedUpdatedAtMs: number | null | undefined;
  #rewoundSinceSuccess = false;

  constructor(config: Partial<LargeUncachedInputGuardConfig> = {}) {
    this.#config = { ...DEFAULT_LARGE_UNCACHED_INPUT_GUARD_CONFIG, ...config };
  }

  reset(): void {
    this.#lastSuccessful = null;
    this.#resumedUpdatedAtMs = undefined;
    this.#rewoundSinceSuccess = false;
  }

  markResumedSession({ updatedAtMs }: { updatedAtMs?: number | null }): void {
    this.#resumedUpdatedAtMs = typeof updatedAtMs === 'number' && Number.isFinite(updatedAtMs) ? updatedAtMs : null;
    this.#rewoundSinceSuccess = false;
    this.#lastSuccessful = null;
  }

  markUndoOrRewind(): void {
    this.#rewoundSinceSuccess = true;
  }

  /**
   * True when session state alone could produce a warning (idle, resume, undo,
   * provider/model/mode change). Callers that only care about the warn action
   * can skip building and serializing the outgoing payload when this is false.
   *
   * Size is not considered here — a large payload with no risk factors still
   * allows, so a false result is definitive.
   */
  mightWarn(context: LargeUncachedInputRiskContext): boolean {
    if (!this.#config.enabled) return false;
    return this.#collectReasons(context).length > 0;
  }

  inspect(context: LargeUncachedInputContext): LargeUncachedInputDecision {
    if (!this.#config.enabled) {
      return allowDecision();
    }

    // Reasons do not depend on payload size. Collect them first so the common
    // "actively chatting, same config" path never serializes the history.
    const reasons = this.#collectReasons(context);
    if (reasons.length === 0) {
      return allowDecision();
    }

    const { estimatedBytes, keyMaterial } = this.#resolveSize(context);
    const estimatedTokens = estimateTokens(estimatedBytes);

    if (estimatedTokens < this.#config.largePromptTokenThreshold) {
      return allowDecision(estimatedTokens, estimatedBytes);
    }

    return {
      action: 'warn',
      warningKey: warningKeyFor(keyMaterial, reasons, context),
      reasons,
      estimatedTokens,
      estimatedBytes,
    };
  }

  #resolveSize(context: LargeUncachedInputContext): { estimatedBytes: number; keyMaterial: string } {
    if (typeof context.estimatedBytes === 'number' && Number.isFinite(context.estimatedBytes)) {
      return {
        estimatedBytes: Math.max(0, context.estimatedBytes),
        keyMaterial: context.contentKey ?? String(context.estimatedBytes),
      };
    }
    const serialized = serializeInput(context.input);
    return {
      estimatedBytes: Buffer.byteLength(serialized),
      keyMaterial: serialized,
    };
  }

  recordSuccessfulInput(context: LargeUncachedInputContext): void {
    this.#lastSuccessful = {
      provider: context.provider,
      model: context.model,
      reasoningEffort: context.reasoningEffort,
      mode: context.mode,
      completedAt: context.now,
    };
    this.#resumedUpdatedAtMs = undefined;
    this.#rewoundSinceSuccess = false;
  }

  #collectReasons(context: LargeUncachedInputRiskContext): LargeUncachedInputWarningReason[] {
    const reasons: LargeUncachedInputWarningReason[] = [];

    if (this.#lastSuccessful) {
      if (this.#lastSuccessful.provider && context.provider && this.#lastSuccessful.provider !== context.provider) {
        reasons.push('provider_changed');
      }
      if (this.#lastSuccessful.model && context.model && this.#lastSuccessful.model !== context.model) {
        reasons.push('model_changed');
      }
      if (
        this.#lastSuccessful.reasoningEffort &&
        context.reasoningEffort &&
        this.#lastSuccessful.reasoningEffort !== context.reasoningEffort
      ) {
        reasons.push('reasoning_effort_changed');
      }
      if (
        this.#lastSuccessful.mode &&
        context.mode &&
        this.#lastSuccessful.mode !== context.mode &&
        !isNonLiteModeTransition(this.#lastSuccessful.mode, context.mode)
      ) {
        reasons.push('mode_changed');
      }
      if (context.now - this.#lastSuccessful.completedAt > this.#config.idleMs) {
        reasons.push('idle_timeout');
      }
    } else if (this.#resumedUpdatedAtMs !== undefined) {
      if (this.#resumedUpdatedAtMs === null) {
        reasons.push('resumed_session_unknown_age');
      } else if (context.now - this.#resumedUpdatedAtMs > this.#config.idleMs) {
        reasons.push('resumed_session_stale');
      }
    }

    if (this.#rewoundSinceSuccess) {
      reasons.push('undo_rewind');
    }

    return reasons;
  }
}
