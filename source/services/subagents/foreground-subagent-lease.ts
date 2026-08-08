import type { ContinuationHandle } from '../../contracts/continuation-handle.js';

/** A decision made against one queued child-tool approval. */
export type BackgroundSubagentApprovalDecision = { kind: 'approve' } | { kind: 'reject'; message?: string };

export interface BackgroundSubagentApprovalSnapshot {
  runId: string;
  generation: number;
  interruption: unknown;
}

/**
 * Owns the cancellation link and resumable pause of one foreground child run.
 *
 * This deliberately has no UI knowledge.  The foreground runner decides how
 * to surface a pause before adoption; after adoption the session resolves the
 * snapshot through this narrow capability and the original child continuation
 * is resumed exactly once.
 */
export class ForegroundSubagentLease {
  readonly #controller = new AbortController();
  readonly #runId: string;
  #detachParentAbort: (() => void) | undefined;
  #adopted = false;
  #settled = false;
  #adoptionWaiters: Array<(adopted: boolean) => void> = [];
  #generation = 0;
  #pending:
    | {
        handle: ContinuationHandle;
        interruption: unknown;
        resolve: (resumed: boolean) => void;
        /**
         * The child loop is deliberately retained with the opaque handle. A
         * decision is not a resume by itself: only this closure can continue
         * the exact ApplicationRunLoop segment that produced the pause.
         */
        resume?: () => void;
      }
    | undefined;

  constructor({ runId, parentSignal }: { runId: string; parentSignal?: AbortSignal }) {
    this.#runId = runId;
    const abortFromParent = () => this.#controller.abort();
    if (parentSignal?.aborted) abortFromParent();
    else parentSignal?.addEventListener('abort', abortFromParent, { once: true });
    this.#detachParentAbort = () => parentSignal?.removeEventListener('abort', abortFromParent);
  }

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  get adopted(): boolean {
    return this.#adopted;
  }

  get runId(): string {
    return this.#runId;
  }

  get settled(): boolean {
    return this.#settled;
  }

  /** Called only after registry capacity/lifetime validation succeeds. */
  adopt(): void {
    if (this.#adopted) throw new Error(`Foreground subagent lease ${this.#runId} is already adopted.`);
    if (this.#settled) throw new Error(`Foreground subagent lease ${this.#runId} has already settled.`);
    if (this.#controller.signal.aborted) throw new Error(`Foreground subagent lease ${this.#runId} is aborting.`);
    this.#detachParentAbort?.();
    this.#detachParentAbort = undefined;
    this.#adopted = true;
    for (const resolve of this.#adoptionWaiters.splice(0)) resolve(true);
  }

  /** Resolves once the registry adopts the lease, or false if it settles first. */
  waitForAdoption(): Promise<boolean> {
    if (this.#adopted) return Promise.resolve(true);
    if (this.#settled || this.#controller.signal.aborted) return Promise.resolve(false);
    return new Promise((resolve) => this.#adoptionWaiters.push(resolve));
  }

  cancel(): void {
    this.#controller.abort();
    for (const resolve of this.#adoptionWaiters.splice(0)) resolve(false);
    this.#releasePending(false);
  }

  settle(): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#detachParentAbort?.();
    this.#detachParentAbort = undefined;
    for (const resolve of this.#adoptionWaiters.splice(0)) resolve(false);
    this.#releasePending(false);
  }

  /**
   * Holds one child continuation. Returns false while the caller must retain
   * foreground ownership, and waits for a background decision after adoption.
   */
  async waitForBackgroundApproval(handle: ContinuationHandle, interruption: unknown): Promise<boolean> {
    return this.#waitForBackgroundApproval(handle, interruption);
  }

  /**
   * Like {@link waitForBackgroundApproval}, but retains the exact child-loop
   * continuation. It is intentionally a raw, already-classified decision
   * seam: approval policy and presentation belong to the session layer.
   */
  async waitForBackgroundContinuation(
    handle: ContinuationHandle,
    interruption: unknown,
    resume: () => void,
  ): Promise<boolean> {
    return this.#waitForBackgroundApproval(handle, interruption, resume);
  }

  async #waitForBackgroundApproval(
    handle: ContinuationHandle,
    interruption: unknown,
    resume?: () => void,
  ): Promise<boolean> {
    if (!this.#adopted) return false;
    if (this.#pending) throw new Error(`Foreground subagent lease ${this.#runId} already has a pending approval.`);
    const resumed = await new Promise<boolean>((resolve) => {
      this.#generation += 1;
      this.#pending = { handle, interruption, resolve, ...(resume ? { resume } : {}) };
    });
    return resumed && !this.#controller.signal.aborted;
  }

  getPendingApproval(): BackgroundSubagentApprovalSnapshot | undefined {
    if (!this.#pending) return undefined;
    return { runId: this.#runId, generation: this.#generation, interruption: this.#pending.interruption };
  }

  resolveBackgroundApproval(generation: number, decision: BackgroundSubagentApprovalDecision): boolean {
    const pending = this.#pending;
    if (!pending || !this.#adopted || generation !== this.#generation || this.#controller.signal.aborted) return false;
    if (decision.kind === 'approve' && !pending.handle.approve) return false;
    if (decision.kind === 'reject' && !pending.handle.reject) return false;
    this.#pending = undefined;
    if (decision.kind === 'approve') pending.handle.approve!(pending.interruption);
    else pending.handle.reject!(pending.interruption, { ...(decision.message ? { message: decision.message } : {}) });
    // Keep the loop resume paired with the handle decision. Callers must not
    // resume a sibling interruption or manufacture a new run.
    pending.resume?.();
    pending.resolve(true);
    return true;
  }

  #releasePending(resumed: boolean): void {
    const pending = this.#pending;
    this.#pending = undefined;
    pending?.resolve(resumed);
  }
}
