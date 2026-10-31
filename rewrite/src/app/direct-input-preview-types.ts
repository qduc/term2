/** Read-only input to the app preview adapter. The owning Session supplies one cut. */
import type { ContentPart, Item } from '../model/index.js';
import type { InputSurgeDecision, InputSurgeInputKind } from '../../../source/services/input-surge-guard.js';
import type { LargeUncachedInputDecision } from '../../../source/services/large-uncached-input-guard.js';

export type DirectInputPreviewRequest = {
  readonly text: string;
  readonly attachments?: readonly ContentPart[];
};

/** Effective request configuration, not startup defaults or a client's display state. */
export type DirectInputPreviewConfiguration = {
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort: string | null;
  /** Source profile label (standard/lite/etc.), not its registry ID. */
  readonly mode: string;
};

export type DirectInputPreviewSnapshot = {
  /**
   * Exact next outgoing native items, including this request's draft, images,
   * pending notices and model-only context. Session selects full history/delta
   * through its real planner without advancing continuity or consuming notices.
   * Never substitute display messages, queued input, or an empty fallback.
   */
  readonly input: readonly Item[];
  readonly kind: InputSurgeInputKind;
  readonly configuration: DirectInputPreviewConfiguration;
  /** Same lifecycle signal as isQueueActive, not the composer's delivery preference. */
  readonly queueActive: boolean;
  /** Only an accepted successful provider input establishes this baseline. */
  readonly lastSuccessful: (DirectInputPreviewConfiguration & { readonly completedAt: number }) | null;
  /** null = not resumed; updatedAtMs:null = resumed with unknown age. */
  readonly resumed: { readonly updatedAtMs: number | null } | null;
  readonly rewoundSinceSuccess: boolean;
  /**
   * Aligned with input, including non-tool positions. Known call/result
   * representations share their actual admission's identity. Never derive this
   * from provider IDs, native Item IDs, argument hashes or display tool rows.
   * null retains the source guard's legacy call-ID heuristic.
   */
  readonly toolOccurrences: readonly ({ readonly turnId: string; readonly occurrence: number } | null)[];
};

export type DirectInputPreviewDecisions = {
  readonly inputSurge: InputSurgeDecision;
  /** Not inspected when surge takes precedence or a foreground queue is active. */
  readonly largeUncachedInput: LargeUncachedInputDecision | null;
};

/** Structurally matches the direct preview capability without importing a client. */
export type DirectInputPreviewResult = {
  readonly notices: readonly { readonly kind: string; readonly message: string }[];
  readonly requiresConfirmation: boolean;
};

export type DirectInputPreviewOptions = {
  /** Unavailable snapshots must throw; absence is not an allow decision. */
  readonly snapshot: (
    request: DirectInputPreviewRequest,
  ) => DirectInputPreviewSnapshot | Promise<DirectInputPreviewSnapshot>;
  readonly now?: () => number;
};
