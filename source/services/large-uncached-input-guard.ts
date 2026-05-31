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
  input: unknown;
  now: number;
  actualPromptTokens?: number;
  provider?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
  mode?: string | null;
}

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

export const getSerializedInputBytes = (input: unknown): number => {
  try {
    const serialized = JSON.stringify(input);
    return Buffer.byteLength(serialized ?? String(input));
  } catch {
    return Buffer.byteLength(String(input));
  }
};

const estimateTokens = (bytes: number): number => Math.ceil(bytes / 4);

const warningKeyFor = (
  input: unknown,
  reasons: LargeUncachedInputWarningReason[],
  context: Pick<LargeUncachedInputContext, 'provider' | 'model' | 'reasoningEffort' | 'mode'>,
): string => {
  const hash = crypto.createHash('sha256');
  try {
    hash.update(JSON.stringify(input) ?? String(input));
  } catch {
    hash.update(String(input));
  }
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

const isStandardPlanTransition = (fromMode?: string | null, toMode?: string | null): boolean => {
  const pair = new Set([fromMode ?? 'standard', toMode ?? 'standard']);
  return pair.size <= 2 && pair.has('standard') && pair.has('plan');
};

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

  inspect(context: LargeUncachedInputContext): LargeUncachedInputDecision {
    const estimatedBytes = getSerializedInputBytes(context.input);
    const estimatedTokens = estimateTokens(estimatedBytes);
    const tokenCount = context.actualPromptTokens ?? estimatedTokens;
    const reasons: LargeUncachedInputWarningReason[] = [];

    if (!this.#config.enabled || tokenCount < this.#config.largePromptTokenThreshold) {
      return {
        action: 'allow',
        warningKey: warningKeyFor(context.input, reasons, context),
        reasons,
        estimatedTokens: tokenCount,
        estimatedBytes,
      };
    }

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
        !isStandardPlanTransition(this.#lastSuccessful.mode, context.mode)
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

    return {
      action: reasons.length > 0 ? 'warn' : 'allow',
      warningKey: warningKeyFor(context.input, reasons, context),
      reasons,
      estimatedTokens: tokenCount,
      estimatedBytes,
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
}
