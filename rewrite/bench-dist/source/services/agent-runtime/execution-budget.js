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
    maxChildren;
    /** Maximum nesting depth (0 = no children). Undefined = unlimited. */
    maxDepth;
    /** Maximum concurrent children. Undefined = unlimited. */
    maxConcurrency;
    /** Maximum aggregate tokens across the tree. Undefined = unlimited. */
    maxTokens;
    /** Current nesting depth of the agent owning this budget. */
    currentDepth;
    /** Shared AbortController for the entire tree. */
    abortController;
    #state;
    constructor(options) {
        this.maxChildren = options.maxChildren;
        this.maxDepth = options.maxDepth;
        this.maxConcurrency = options.maxConcurrency;
        this.maxTokens = options.maxTokens;
        this.currentDepth = options.currentDepth ?? 0;
        this.abortController = options.abortController ?? new AbortController();
        this.#state = options.sharedState ?? { childCount: 0, activeChildren: 0, aggregateTokens: 0, released: false };
    }
    /** Shared abort signal for the tree. */
    get signal() {
        return this.abortController.signal;
    }
    /** Current child count (for inspection). */
    get childCount() {
        return this.#state.childCount;
    }
    /** Current active (in-progress) children. */
    get activeChildren() {
        return this.#state.activeChildren;
    }
    /** Aggregate token usage across the tree. */
    get aggregateTokens() {
        return this.#state.aggregateTokens;
    }
    /** Whether any limit has been exceeded or the tree was aborted. */
    get isExhausted() {
        return this.#state.released || this.abortController.signal.aborted;
    }
    /**
     * Try to acquire a child slot. Returns an AcquiredChildSlot or a rejection reason.
     * This increments child count and active concurrency atomically.
     *
     * Callers MUST call `release()` on the returned slot in a finally block.
     */
    tryAcquireChild() {
        if (this.#state.released) {
            return { accepted: false, reason: 'budget_released' };
        }
        if (this.abortController.signal.aborted) {
            return { accepted: false, reason: 'cancelled' };
        }
        // Check maxChildren
        if (this.maxChildren !== undefined && this.#state.childCount >= this.maxChildren) {
            return {
                accepted: false,
                reason: 'max_children_exceeded',
                current: this.#state.childCount,
                max: this.maxChildren,
            };
        }
        // Check maxConcurrency
        if (this.maxConcurrency !== undefined && this.#state.activeChildren >= this.maxConcurrency) {
            return {
                accepted: false,
                reason: 'max_concurrency_exceeded',
                current: this.#state.activeChildren,
                max: this.maxConcurrency,
            };
        }
        // Check token budget
        if (this.maxTokens !== undefined && this.#state.aggregateTokens >= this.maxTokens) {
            return {
                accepted: false,
                reason: 'max_tokens_exceeded',
                current: this.#state.aggregateTokens,
                max: this.maxTokens,
            };
        }
        this.#state.childCount++;
        this.#state.activeChildren++;
        return new AcquiredChildSlot(this, () => this.#releaseChild());
    }
    /** Called by AcquiredChildSlot to release a slot. */
    #releaseChild() {
        if (this.#state.activeChildren > 0) {
            this.#state.activeChildren--;
        }
    }
    /**
     * Record token usage from a completed child run.
     * If aggregate exceeds maxTokens, the shared abort signal is triggered.
     */
    recordUsage(usage) {
        const tokens = usage.total_tokens ?? (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0);
        this.#state.aggregateTokens += tokens;
        if (this.maxTokens !== undefined && this.#state.aggregateTokens >= this.maxTokens) {
            this.#state.released = true;
            try {
                this.abortController.abort();
            }
            catch {
                // AbortController may already be aborted
            }
        }
    }
    /** Abort the entire tree. */
    abort() {
        this.#state.released = true;
        try {
            this.abortController.abort();
        }
        catch {
            // Already aborted
        }
    }
    /**
     * Create a child budget from this parent, decrementing depth.
     * Child limits are inherited (same maxChildren, maxConcurrency, maxTokens)
     * and reference the shared abort controller.
     */
    createChildBudget() {
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
            sharedState: this.#state,
        });
    }
    /** Release all resources (called when root execution completes). */
    release() {
        this.#state.released = true;
        try {
            this.abortController.abort();
        }
        catch {
            // Already aborted
        }
    }
}
/**
 * Opaque handle returned by tryAcquireChild().
 * Call release() when the child completes (in a finally block).
 */
export class AcquiredChildSlot {
    #budget;
    #releaseFn;
    #released = false;
    constructor(budget, releaseFn) {
        this.#budget = budget;
        this.#releaseFn = releaseFn;
    }
    /** Signal slice for the child. Derived from the shared tree signal. */
    get signal() {
        return this.#budget.signal;
    }
    /** Release the slot, decrementing active children count. */
    release() {
        if (this.#released)
            return;
        this.#released = true;
        this.#releaseFn();
    }
    /**
     * Create a child budget for the acquired slot.
     * Delegates to parent's createChildBudget but also applies
     * the current depth check.
     */
    createChildBudget() {
        return this.#budget.createChildBudget();
    }
}
/**
 * Create a root ExecutionBudget from AgentLimits.
 * This is the entry point for a top-level agent run.
 */
export function createRootBudget(limits) {
    return new ExecutionBudget({
        maxChildren: limits.maxChildren,
        maxDepth: limits.maxDepth,
        maxConcurrency: limits.maxConcurrency,
        maxTokens: limits.maxTokens,
    });
}
//# sourceMappingURL=execution-budget.js.map