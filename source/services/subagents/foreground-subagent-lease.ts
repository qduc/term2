import type { ContinuationHandle } from '../../contracts/continuation-handle.js';

export interface BackgroundSubagentApprovalSnapshot {
  runId: string;
  generation: number;
  interruption: unknown;
}

/**
 * The exact child continuation made available to session-owned approval
 * policy. A caller cannot resume the child directly: it must apply its
 * decision synchronously through {@link ForegroundSubagentLease}, which
 * commits the single continuation only if the pause is still current.
 */
export interface BackgroundSubagentApprovalApplication {
  readonly runId: string;
  readonly generation: number;
  readonly handle: ContinuationHandle;
  readonly interruption: unknown;
}

/** Session-facing publication for one adopted child pause. */
export interface BackgroundSubagentApprovalPause extends BackgroundSubagentApprovalSnapshot {
  readonly role: string;
  /**
   * Atomically validates this pause, applies policy to its exact continuation,
   * then resumes its exact child loop. Returns false when the pause is stale.
   */
  apply(callback: (application: BackgroundSubagentApprovalApplication) => boolean): boolean;
}

/** Session-owned queue/control boundary; it has no Ink or policy dependency. */
export type BackgroundSubagentApprovalPauseSink = (pause: BackgroundSubagentApprovalPause) => void;

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
        reject: (error: unknown) => void;
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
    onPending?: (snapshot: BackgroundSubagentApprovalSnapshot) => void,
  ): Promise<boolean> {
    return this.#waitForBackgroundApproval(handle, interruption, resume, onPending);
  }

  async #waitForBackgroundApproval(
    handle: ContinuationHandle,
    interruption: unknown,
    resume?: () => void,
    onPending?: (snapshot: BackgroundSubagentApprovalSnapshot) => void,
  ): Promise<boolean> {
    if (!this.#adopted) return false;
    if (this.#pending) throw new Error(`Foreground subagent lease ${this.#runId} already has a pending approval.`);
    const resumed = await new Promise<boolean>((resolve, reject) => {
      this.#generation += 1;
      this.#pending = { handle, interruption, resolve, reject, ...(resume ? { resume } : {}) };
      onPending?.({ runId: this.#runId, generation: this.#generation, interruption });
    });
    return resumed && !this.#controller.signal.aborted;
  }

  getPendingApproval(): BackgroundSubagentApprovalSnapshot | undefined {
    if (!this.#pending) return undefined;
    return { runId: this.#runId, generation: this.#generation, interruption: this.#pending.interruption };
  }

  /**
   * Applies session policy to one exact pause, then resumes the child loop
   * once. This deliberately accepts a callback rather than an approve/reject
   * enum: policy owns all approval variants and is the only layer allowed to
   * touch the opaque continuation handle.
   *
   * Returns false for stale, cancelled, or already-consumed pauses. A policy
   * exception leaves the pause intact, letting its queue retain ownership.
   */
  applyBackgroundApproval(
    expected: BackgroundSubagentApprovalSnapshot,
    apply: (application: BackgroundSubagentApprovalApplication) => boolean,
  ): boolean {
    const pending = this.#pending;
    if (
      !pending ||
      !this.#adopted ||
      expected.runId !== this.#runId ||
      expected.generation !== this.#generation ||
      expected.interruption !== pending.interruption ||
      this.#controller.signal.aborted
    )
      return false;

    const applied = apply({
      runId: this.#runId,
      generation: this.#generation,
      handle: pending.handle,
      interruption: pending.interruption,
    });
    if (!applied) return false;
    this.#pending = undefined;
    // Keep the loop resume paired with the handle decision. Callers must not
    // resume a sibling interruption or manufacture a new run.
    try {
      pending.resume?.();
      pending.resolve(true);
    } catch (error) {
      // The policy already decided the opaque handle. Retrying this queue head
      // would apply that decision twice, so consume it and fail the retained
      // child execution through its durable async terminal path instead.
      pending.reject(error);
    }
    return true;
  }

  #releasePending(resumed: boolean): void {
    const pending = this.#pending;
    this.#pending = undefined;
    pending?.resolve(resumed);
  }
}
