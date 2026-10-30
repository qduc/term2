export class ServerSessionError extends Error {
    code;
    constructor(code) {
        super('server session operation rejected');
        this.name = 'ServerSessionError';
        this.code = code;
    }
}
function withTimeout(promise, timeoutMs) {
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
        promise.then((value) => {
            clearTimeout(timer);
            resolve({ timedOut: false, value });
        }, () => {
            clearTimeout(timer);
            resolve({ timedOut: true });
        });
    });
}
export class ServerSession {
    id;
    ownerUserId;
    workspaceId;
    binding;
    service;
    handle;
    #status = 'idle';
    #activeTurnId = null;
    #abortGeneration = 0;
    #settledTurns = new Set();
    #cancelledLeases = new Set();
    #disposePromise = null;
    #preparedTurns = new Map();
    #composition;
    #policy;
    #eventSink;
    #onDispose;
    #disposeHooks = new Set();
    #deadline;
    #lastAbortOutcome;
    #commandTurnId = null;
    constructor(options) {
        this.id = options.binding.sessionId;
        this.ownerUserId = options.binding.ownerUserId;
        this.workspaceId = options.binding.workspaceId;
        this.binding = Object.freeze({ ...options.binding });
        this.service = options.service;
        this.handle = options.handle;
        this.#composition = options.composition;
        this.#policy = options.policy;
        this.#eventSink = options.eventSink;
        this.#onDispose = options.onDispose;
        this.handle.setQueuedTurnStartObserver((execution) => {
            if (this.#status === 'interrupted' || this.#status === 'closed')
                return;
            this.#activeTurnId = execution.requestId;
            this.#status = 'running';
            this.#startDeadline(execution.requestId);
        });
        this.handle.setEventSink((event) => this.#dispatchEvent(event));
    }
    /**
     * The single runtime event sink. `turnIdOverride` exists for a session
     * command, whose events are raised outside any turn.
     */
    async #dispatchEvent(event, turnIdOverride) {
        if (event.type === 'approval_required')
            this.#status = 'awaiting_interaction';
        const discardedTurnIds = event.type === 'error' ? this.service.consumeFailureDiscardedTurnIds() : [];
        for (const discardedTurnId of discardedTurnIds)
            this.#settledTurns.add(discardedTurnId);
        const turnId = turnIdOverride ?? this.#activeTurnId ?? this.#commandTurnId ?? undefined;
        if (event.type === 'final' || event.type === 'error') {
            if (this.#activeTurnId)
                this.#settledTurns.add(this.#activeTurnId);
            this.#activeTurnId = null;
            this.#clearDeadline();
        }
        if (this.#status !== 'interrupted' && this.#status !== 'closed') {
            this.#status = this.#computePublicStatus();
        }
        try {
            await this.#eventSink?.(event, { turnId, discardedTurnIds });
        }
        catch (error) {
            this.handle.closeAdmission();
            this.#status = 'interrupted';
            throw error;
        }
    }
    /**
     * Attribute the events raised by `run` to `turnId`. Compact is the only
     * command that publishes conversation events, and it runs outside a turn, so
     * without this the gateway sees no turn and drops `context_compaction_*`
     * before it reaches the journal.
     */
    async withCommandTurn(turnId, run) {
        const previous = this.#commandTurnId;
        this.#commandTurnId = turnId;
        try {
            return await run();
        }
        finally {
            this.#commandTurnId = previous;
        }
    }
    get sessionId() {
        return this.id;
    }
    #computePublicStatus() {
        if (this.#status === 'interrupted' || this.#status === 'closed')
            return this.#status;
        if (this.#activeTurnId) {
            if (this.#status === 'awaiting_interaction')
                return 'awaiting_interaction';
            return 'running';
        }
        const approvals = this.service.backgroundSubagentApprovals?.getSnapshot?.();
        if (approvals && approvals.pendingCount > 0)
            return 'awaiting_interaction';
        const details = this.service.backgroundTaskControl?.listDetails?.() ?? [];
        for (const d of details) {
            if (d.kind === 'subagent') {
                if (d.status === 'awaiting_approval' || d.status === 'waiting_for_answer') {
                    return 'awaiting_interaction';
                }
                if (d.status === 'running' || d.status === 'cancelling') {
                    return 'running';
                }
            }
            else if (d.kind === 'shell') {
                if (d.status === 'running' || d.status === 'cancelling') {
                    return 'running';
                }
            }
        }
        return 'idle';
    }
    get status() {
        if (this.#status === 'interrupted' || this.#status === 'closed')
            return this.#status;
        return this.#computePublicStatus();
    }
    get activeTurnId() {
        return this.#activeTurnId;
    }
    get abortGeneration() {
        return this.#abortGeneration;
    }
    get lastAbortOutcome() {
        return this.#lastAbortOutcome;
    }
    get settings() {
        return Object.freeze({ ...this.#composition.settings });
    }
    get resources() {
        return this.#composition;
    }
    /** Register lifecycle ownership without replacing the class dispose method. */
    addDisposeHook(hook) {
        if (this.#disposePromise) {
            hook();
            return;
        }
        this.#disposeHooks.add(hook);
    }
    prepareMessage(input, ids) {
        if (this.#status === 'closed' || this.#status === 'interrupted') {
            return Promise.resolve({ kind: 'rejected', reason: 'closed' });
        }
        return this.handle.prepare(input, ids).then((result) => {
            if (result.kind === 'prepared')
                this.#preparedTurns.set(result.leaseId, result.turnId);
            return result;
        });
    }
    async commitMessage(leaseId) {
        this.assertOpen();
        const turnId = this.#preparedTurns.get(leaseId);
        if (!turnId)
            throw new ServerSessionError('wrong_turn');
        const resetBudget = this.#composition.providerBroker
            ?.resetRequestBudget;
        resetBudget?.();
        try {
            await this.handle.commit(leaseId);
        }
        catch (error) {
            this.#preparedTurns.delete(leaseId);
            throw error;
        }
        this.#preparedTurns.delete(leaseId);
    }
    async cancelPreparedMessage(leaseId) {
        if (this.#status === 'closed')
            throw new ServerSessionError('closed');
        if (this.#cancelledLeases.has(leaseId))
            return;
        await this.handle.cancelPrepared(leaseId);
        this.#preparedTurns.delete(leaseId);
        this.#cancelledLeases.add(leaseId);
    }
    createRetryRuntime(command) {
        return {
            prepareMessage: async (_input, ids) => {
                if (this.#status === 'closed' || this.#status === 'interrupted') {
                    return { kind: 'rejected', reason: 'closed' };
                }
                if (this.#status === 'running' || this.#status === 'awaiting_interaction') {
                    return { kind: 'rejected', reason: 'busy' };
                }
                const result = await this.handle.prepare('', ids);
                if (result.kind === 'prepared') {
                    this.#preparedTurns.set(result.leaseId, result.turnId);
                }
                return result;
            },
            commitMessage: async (leaseId) => {
                this.assertOpen();
                const turnId = this.#preparedTurns.get(leaseId);
                if (!turnId)
                    throw new ServerSessionError('wrong_turn');
                const resetBudget = this.#composition.providerBroker
                    .resetRequestBudget;
                resetBudget?.();
                try {
                    await this.handle.cancelPrepared(leaseId);
                }
                catch {
                    // ignore cleanup errors
                }
                this.#preparedTurns.delete(leaseId);
                await new Promise((resolve, reject) => {
                    let admitted = false;
                    const onAdmission = (error) => {
                        if (admitted)
                            return;
                        admitted = true;
                        if (error) {
                            reject(error);
                        }
                        else {
                            resolve();
                        }
                    };
                    try {
                        const retryPromise = command === 'retry-tool'
                            ? this.service.retryLastToolOutput({
                                preferredMessageId: turnId,
                                onAdmission,
                            })
                            : this.service.retryLastFailedTurn({
                                preferredMessageId: turnId,
                                onAdmission,
                            });
                        retryPromise.then((terminal) => {
                            if (terminal !== null)
                                return;
                            if (!admitted) {
                                admitted = true;
                                reject(new ServerSessionError('wrong_turn'));
                                return;
                            }
                            // The retry reported nothing to replay after the turn was
                            // already admitted, so the durable assistant_started would
                            // strand. Settle it through the journal: the gateway maps the
                            // error event to turn_failed and moves the admission to
                            // terminal.
                            this.#settledTurns.add(turnId);
                            void this.#dispatchEvent({ type: 'error', message: 'There is no failed turn to retry.', kind: 'runtime_error' }, turnId).catch(() => undefined);
                        }, (error) => {
                            if (!admitted) {
                                admitted = true;
                                reject(error);
                            }
                        });
                    }
                    catch (error) {
                        if (!admitted) {
                            admitted = true;
                            reject(error);
                        }
                    }
                });
                if (!this.#activeTurnId && !this.#settledTurns.has(turnId)) {
                    this.#activeTurnId = turnId;
                    this.#status = 'running';
                    this.#startDeadline(turnId);
                }
            },
            cancelPreparedMessage: async (leaseId) => {
                await this.cancelPreparedMessage(leaseId);
            },
        };
    }
    resolvePendingInteraction(request) {
        this.assertOpen();
        const result = this.handle.resolveInteraction(request);
        if (result.kind === 'stale_interaction')
            throw new ServerSessionError('stale_interaction');
        return result;
    }
    async abort(turnId) {
        if (this.#settledTurns.has(turnId))
            return { kind: 'already_settled', turnId };
        if (this.#status === 'closed')
            return { kind: 'already_settled', turnId };
        if (this.#status === 'interrupted') {
            const outcome = { kind: 'interrupted', turnId, reason: 'cancellation_timeout' };
            this.#lastAbortOutcome = outcome;
            return outcome;
        }
        if (!this.#activeTurnId)
            return { kind: 'no_op', turnId };
        if (this.#activeTurnId !== turnId)
            throw new ServerSessionError('wrong_turn');
        // Close admission before awaiting the bounded barrier. This makes a
        // cancellation race fail closed instead of letting fresh work auto-run.
        this.#abortGeneration += 1;
        this.handle.closeAdmission();
        try {
            const result = await this.handle.abortAndDiscard();
            if (!result.proven) {
                const outcome = { kind: 'interrupted', turnId, reason: 'cancellation_timeout' };
                this.#status = 'interrupted';
                this.#lastAbortOutcome = outcome;
                return outcome;
            }
            this.#settledTurns.add(turnId);
            for (const discardedTurnId of result.discardedTurnIds)
                this.#settledTurns.add(discardedTurnId);
            this.#preparedTurns.clear();
            this.#activeTurnId = null;
            this.#status = this.#computePublicStatus();
            this.#clearDeadline();
            this.handle.reopenAdmission();
            const outcome = { kind: 'aborted', turnId, discardedTurnIds: result.discardedTurnIds };
            this.#lastAbortOutcome = outcome;
            return outcome;
        }
        catch {
            this.#status = 'interrupted';
            const outcome = { kind: 'interrupted', turnId, reason: 'cancellation_timeout' };
            this.#lastAbortOutcome = outcome;
            return outcome;
        }
    }
    async dispose(reason = 'closed') {
        if (this.#disposePromise)
            return this.#disposePromise;
        this.#disposePromise = (async () => {
            this.handle.closeAdmission();
            this.#preparedTurns.clear();
            this.#clearDeadline();
            let interrupted = reason === 'interrupted';
            const cancellation = await withTimeout(this.handle.abortAndDiscard(), this.#policy.shutdownGraceMs);
            if (cancellation.timedOut || !cancellation.value?.proven)
                interrupted = true;
            const shutdown = await withTimeout(this.handle.shutdown(), this.#policy.shutdownGraceMs);
            if (shutdown.timedOut)
                interrupted = true;
            await Promise.resolve(this.#composition.dispose());
            this.#activeTurnId = null;
            this.#status = interrupted && reason === 'interrupted' ? 'interrupted' : 'closed';
            for (const hook of this.#disposeHooks)
                await hook();
            this.#disposeHooks.clear();
            this.#onDispose?.();
        })();
        return this.#disposePromise;
    }
    assertOpen() {
        if (this.#status === 'closed')
            throw new ServerSessionError('closed');
        if (this.#status === 'interrupted')
            throw new ServerSessionError('interrupted');
    }
    #startDeadline(turnId) {
        this.#clearDeadline();
        this.#deadline = setTimeout(() => {
            void this.abort(turnId).then((outcome) => {
                this.#lastAbortOutcome = outcome;
            }, () => {
                this.#status = 'interrupted';
                this.#lastAbortOutcome = { kind: 'interrupted', turnId, reason: 'cancellation_timeout' };
            });
        }, this.#policy.maxActiveTurnMs);
        this.#deadline.unref?.();
    }
    #clearDeadline() {
        if (this.#deadline)
            clearTimeout(this.#deadline);
        this.#deadline = undefined;
    }
}
//# sourceMappingURL=server-session.js.map