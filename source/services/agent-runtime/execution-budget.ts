import type { NormalizedUsage } from '../../utils/ai/token-usage.js';

/**
 * Shared execution-tree budget context propagated through nested agent runs.
 *
 * Tracks aggregate resource consumption across all children in a tree:
 * - Child count (atomic increment guarding maxChildren)
 * - Active concurrency (atomic increment guard before start, decrement in finally)
 * - Aggregate token usage across the tree
 * - Single AbortController for the entire tree (any child abort propagates)
 * - Depth checking against maxDepth
 *
 * Instances are cheap to create and intended to be shared via the
 * parent agent's run context. The root execution creates the first
 * budget; each child run receives a reference and updates it atomically.
 */
export class ExecutionBudget {
  /** Maximum child agent count allowed (undefined = unlimited). */
  readonly maxChildren: number | undefined;
  /** Maximum nesting depth (0 = no children). Undefined = unlimited. */
  readonly maxDepth: number | undefined;
  /** Maximum concurrent children. Undefined = unlimited. */
  readonly maxConcurrency: number | undefined;
  /** Maximum aggregate tokens across the tree. Undefined = unlimited. */
  readonly maxTokens: number | undefined;

  /** Current nesting depth of the agent owning this budget. */
  readonly currentDepth: number;

  /** Shared AbortController for the entire tree. */
  readonly abortController: AbortController;

  #childCount = 0;
  #activeChildren = 0;
  #aggregateTokens = 0;
  #released = false;

  constructor(options: {
    maxChildren?: number;
    maxDepth?: number;
    maxConcurrency?: number;
    maxTokens?: number;
    currentDepth?: number;
    abortController?: AbortController;
  }) {
    this.maxChildren = options.maxChildren;
    this.maxDepth = options.maxDepth;
    this.maxConcurrency = options.maxConcurrency;
    this.maxTokens = options.maxTokens;
    this.currentDepth = options.currentDepth ?? 0;
    this.abortController = options.abortController ?? new AbortController();
  }

  /** Shared abort signal for the tree. */
  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  /** Current child count (for inspection). */
  get childCount(): number {
    return this.#childCount;
  }

  /** Current active (in-progress) children. */
  get activeChildren(): number {
    return this.#activeChildren;
  }

  /** Aggregate token usage across the tree. */
  get aggregateTokens(): number {
    return this.#aggregateTokens;
  }

  /** Whether any limit has been exceeded or the tree was aborted. */
  get isExhausted(): boolean {
    return this.#released || this.abortController.signal.aborted;
  }

  /**
   * Try to acquire a child slot. Returns an AcquiredChildSlot or a rejection reason.
   * This increments child count and active concurrency atomically.
   *
   * Callers MUST call `release()` on the returned slot in a finally block.
   */
  tryAcquireChild(): AcquiredChildSlot | ChildAcquireRejection {
    if (this.#released) {
      return { accepted: false, reason: 'budget_released' };
    }

    if (this.abortController.signal.aborted) {
      return { accepted: false, reason: 'cancelled' };
    }

    // Check maxChildren
    if (this.maxChildren !== undefined && this.#childCount >= this.maxChildren) {
      return { accepted: false, reason: 'max_children_exceeded', current: this.#childCount, max: this.maxChildren };
    }

    // Check maxConcurrency
    if (this.maxConcurrency !== undefined && this.#activeChildren >= this.maxConcurrency) {
      return {
        accepted: false,
        reason: 'max_concurrency_exceeded',
        current: this.#activeChildren,
        max: this.maxConcurrency,
      };
    }

    // Check token budget
    if (this.maxTokens !== undefined && this.#aggregateTokens >= this.maxTokens) {
      return {
        accepted: false,
        reason: 'max_tokens_exceeded',
        current: this.#aggregateTokens,
        max: this.maxTokens,
      };
    }

    this.#childCount++;
    this.#activeChildren++;

    return new AcquiredChildSlot(this, () => this.#releaseChild());
  }

  /** Called by AcquiredChildSlot to release a slot. */
  #releaseChild(): void {
    if (this.#activeChildren > 0) {
      this.#activeChildren--;
    }
  }

  /**
   * Record token usage from a completed child run.
   * If aggregate exceeds maxTokens, the shared abort signal is triggered.
   */
  recordUsage(usage: NormalizedUsage): void {
    const tokens = usage.total_tokens ?? (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0);
    this.#aggregateTokens += tokens;

    if (this.maxTokens !== undefined && this.#aggregateTokens >= this.maxTokens) {
      this.#released = true;
      try {
        this.abortController.abort();
      } catch {
        // AbortController may already be aborted
      }
    }
  }

  /** Abort the entire tree. */
  abort(): void {
    this.#released = true;
    try {
      this.abortController.abort();
    } catch {
      // Already aborted
    }
  }

  /**
   * Create a child budget from this parent, decrementing depth.
   * Child limits are inherited (same maxChildren, maxConcurrency, maxTokens)
   * and reference the shared abort controller.
   */
  createChildBudget(): ExecutionBudget {
    const depth = this.currentDepth + 1;

    // Check maxDepth before creating
    if (this.maxDepth !== undefined && depth > this.maxDepth) {
      throw new Error(`Maximum agent depth (${this.maxDepth}) exceeded at depth ${depth}.`);
    }

    return new ExecutionBudget({
      maxChildren: this.maxChildren,
      maxDepth: this.maxDepth,
      maxConcurrency: this.maxConcurrency,
      maxTokens: this.maxTokens,
      currentDepth: depth,
      abortController: this.abortController,
    });
  }

  /** Release all resources (called when root execution completes). */
  release(): void {
    this.#released = true;
    try {
      this.abortController.abort();
    } catch {
      // Already aborted
    }
  }
}

/**
 * Opaque handle returned by tryAcquireChild().
 * Call release() when the child completes (in a finally block).
 */
export class AcquiredChildSlot {
  #budget: ExecutionBudget;
  #releaseFn: () => void;

  constructor(budget: ExecutionBudget, releaseFn: () => void) {
    this.#budget = budget;
    this.#releaseFn = releaseFn;
  }

  /** Signal slice for the child. Derived from the shared tree signal. */
  get signal(): AbortSignal {
    return this.#budget.signal;
  }

  /** Release the slot, decrementing active children count. */
  release(): void {
    this.#releaseFn();
  }

  /**
   * Create a child budget for the acquired slot.
   * Delegates to parent's createChildBudget but also applies
   * the current depth check.
   */
  createChildBudget(): ExecutionBudget {
    return this.#budget.createChildBudget();
  }
}

export interface ChildAcquireRejection {
  accepted: false;
  reason:
    | 'budget_released'
    | 'cancelled'
    | 'max_children_exceeded'
    | 'max_concurrency_exceeded'
    | 'max_tokens_exceeded';
  current?: number;
  max?: number;
}

/**
 * Create a root ExecutionBudget from AgentLimits.
 * This is the entry point for a top-level agent run.
 */
export function createRootBudget(limits: {
  maxChildren?: number;
  maxDepth?: number;
  maxConcurrency?: number;
  maxTokens?: number;
}): ExecutionBudget {
  return new ExecutionBudget({
    maxChildren: limits.maxChildren,
    maxDepth: limits.maxDepth,
    maxConcurrency: limits.maxConcurrency,
    maxTokens: limits.maxTokens,
  });
}
