const freeze = (value) => {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const nested of Object.values(value))
            freeze(nested);
    }
    return value;
};
const isNonEmptyString = (value) => typeof value === 'string' && value.length > 0;
const isPauseReason = (value) => value === 'failure' || value === 'manual' || value === 'recovered_interrupted';
const isValidPreflightKind = (value) => value === 'input_surge' || value === 'large_uncached_input';
const isValidActiveActionKind = (value) => value === 'tool_approval' || value === 'ask_user';
const isPersistedQueueItem = (value) => {
    if (!value || typeof value !== 'object')
        return false;
    const item = value;
    if (!isNonEmptyString(item.id) ||
        typeof item.text !== 'string' ||
        !Number.isSafeInteger(item.sequence) ||
        item.sequence <= 0 ||
        !isNonEmptyString(item.submittedAt) ||
        Number.isNaN(Date.parse(item.submittedAt)) ||
        (item.steer !== undefined && typeof item.steer !== 'boolean')) {
        return false;
    }
    if (item.preflight !== undefined) {
        if (!item.preflight ||
            typeof item.preflight !== 'object' ||
            !isNonEmptyString(item.preflight.actionId) ||
            !isValidPreflightKind(item.preflight.kind)) {
            return false;
        }
    }
    return true;
};
const validatePersistedQueue = (value) => {
    if (!value || typeof value !== 'object')
        return 'record must be an object';
    const record = value;
    if (record.version !== 1)
        return 'unsupported queue record version';
    if (!Number.isSafeInteger(record.nextSequence) || record.nextSequence < 1)
        return 'invalid next sequence';
    if (!Array.isArray(record.queue) || !record.queue.every(isPersistedQueueItem))
        return 'invalid queued item';
    const queue = record.queue;
    if (queue.some((item, index) => index > 0 && item.sequence <= queue[index - 1].sequence)) {
        return 'queue sequences must be strictly increasing';
    }
    if (queue.some((item) => item.sequence >= record.nextSequence))
        return 'next sequence must exceed queue sequences';
    if (new Set(queue.map((item) => item.id)).size !== queue.length)
        return 'queue item IDs must be unique';
    if (record.pause !== undefined) {
        if (!record.pause ||
            typeof record.pause !== 'object' ||
            !isPauseReason(record.pause.reason)) {
            return 'invalid pause record';
        }
    }
    if (record.active !== undefined) {
        if (!record.active || typeof record.active !== 'object')
            return 'invalid active record';
        const active = record.active;
        if (!isNonEmptyString(active.executionId) || !isPersistedQueueItem(active.item) || !('snapshot' in active))
            return 'invalid active ownership';
        if (!['running', 'awaiting_active_action', 'cancelling', 'completing'].includes(active.phase))
            return 'invalid active phase';
        if (active.pendingAction !== undefined) {
            if (!active.pendingAction ||
                typeof active.pendingAction !== 'object' ||
                !isNonEmptyString(active.pendingAction.actionId) ||
                !isValidActiveActionKind(active.pendingAction.kind)) {
                return 'invalid active action';
            }
        }
        if (queue.some((item) => item.id === active.item.id))
            return 'active item is also queued';
    }
    return value;
};
const persistedItemToQueueItem = (item) => freeze({
    ...item,
    id: item.id,
    preflight: item.preflight
        ? { actionId: item.preflight.actionId, kind: item.preflight.kind }
        : undefined,
});
const queueItemToPersisted = (item) => ({
    id: item.id,
    text: item.text,
    sequence: item.sequence,
    submittedAt: item.submittedAt,
    ...(item.steer ? { steer: true } : {}),
    preflight: item.preflight ? { actionId: item.preflight.actionId, kind: item.preflight.kind } : undefined,
});
export class QueueController {
    #driver;
    #snapshotFactory;
    #capacity;
    #itemId;
    #executionId;
    #actionId;
    #now;
    #completionBarrier;
    #persistence;
    #preflightEvaluator;
    #nextSequence = 1;
    #queue = [];
    #phase = 'idle';
    #active;
    #pendingAction;
    #pauseReason;
    #recovery;
    #persistenceWrites = Promise.resolve();
    /** Out-of-band occupancy (manual compaction) that must not start queued work. */
    #dispatchHeld = false;
    #cancellationUnproven = false;
    #cancellationExecutionId = null;
    #cancelRetainedItemIds = new Set();
    constructor(options) {
        this.#driver = options.driver;
        this.#snapshotFactory = options.snapshotFactory;
        this.#capacity = options.capacity ?? Infinity;
        this.#itemId = options.ids?.item ?? (() => crypto.randomUUID());
        this.#executionId = options.ids?.execution ?? (() => crypto.randomUUID());
        this.#actionId = options.ids?.action ?? (() => crypto.randomUUID());
        this.#now = options.now ?? (() => new Date().toISOString());
        this.#completionBarrier = options.completionBarrier;
        this.#persistence = options.persistence;
        this.#preflightEvaluator = options.preflightEvaluator;
        this.#restore();
    }
    /**
     * Prevent `#dispatch` while idle. Submissions still enqueue. The completion
     * barrier may reserve the next idle boundary with `afterCompletion`; ordinary
     * callers cannot acquire a hold while a turn or another hold owns the queue.
     */
    holdDispatch(options = {}) {
        const completing = options.afterCompletion && this.#phase === 'completing';
        const inactive = this.#phase === 'idle' || (options.allowPaused && this.#phase === 'paused');
        if (this.#dispatchHeld || (!completing && (!inactive || this.#active)))
            return false;
        this.#dispatchHeld = true;
        return true;
    }
    /** Under a dispatch hold, prove that normal resume retains exactly the pending input. Never repairs storage. */
    async assertRestartDurable() {
        const writes = this.#persistenceWrites;
        await writes;
        if (!this.#dispatchHeld || this.#active || writes !== this.#persistenceWrites) {
            throw new Error('Queue ownership changed while preparing restart; try again.');
        }
        if (!this.#persistence) {
            if (this.#queue.length)
                throw new Error('Pending input has no durable queue storage.');
            return;
        }
        const raw = this.#persistence.load();
        if (raw == null && this.#queue.length === 0)
            return;
        const record = validatePersistedQueue(raw);
        if (typeof record === 'string')
            throw new Error(`Cannot verify pending input on disk: ${record}.`);
        // Restore remints preflight action IDs and pauses retained work. Neither is
        // input. A persisted interrupted active item is dropped, never replayed.
        const pending = (items) => items.map((item) => ({
            id: item.id,
            text: item.text,
            sequence: item.sequence,
            submittedAt: item.submittedAt,
            steer: Boolean(item.steer),
            preflight: item.preflight?.kind,
        }));
        if (JSON.stringify(pending(record.queue)) !== JSON.stringify(pending(this.#queue))) {
            throw new Error('Pending input differs from its durable queue file; restart was not performed.');
        }
    }
    isDispatchHeld() {
        return this.#dispatchHeld;
    }
    /**
     * Drop the hold. By default the next queued item starts. `pauseIfQueued`
     * matches stop-during-a-turn: retained work stays paused instead of running.
     */
    releaseDispatch(options = {}) {
        if (!this.#dispatchHeld)
            return;
        this.#dispatchHeld = false;
        if (options.pauseIfQueued && this.#queue.length > 0 && this.#phase === 'idle' && !this.#active) {
            this.#phase = 'paused';
            this.#pauseReason = 'manual';
            void this.#persist();
            return;
        }
        void this.#dispatch();
    }
    state() {
        const queue = this.#queue.map((item) => ({ ...item }));
        const recovery = this.#recovery ? { recovery: this.#recovery } : {};
        if (this.#phase === 'awaiting_preflight') {
            return freeze({
                kind: 'awaiting_preflight',
                queue,
                head: { ...queue[0] },
                ...recovery,
            });
        }
        if (this.#phase === 'awaiting_active_action') {
            return freeze({
                kind: 'awaiting_active_action',
                queue,
                active: this.#active,
                pendingAction: this.#pendingAction,
                ...recovery,
            });
        }
        if (this.#phase === 'paused')
            return freeze({ kind: 'paused', queue, reason: this.#pauseReason, ...recovery });
        if (this.#phase === 'cancelling')
            return freeze({ kind: 'cancelling', queue, active: this.#active, ...recovery });
        if (this.#phase === 'completing')
            return freeze({ kind: 'completing', queue, active: this.#active, ...recovery });
        if (this.#active)
            return freeze({ kind: 'running', queue, active: this.#active, ...recovery });
        return freeze({ kind: 'idle', queue, ...recovery });
    }
    async command(cmd) {
        switch (cmd.kind) {
            case 'submit_held':
                if (!this.#dispatchHeld || this.#phase !== 'idle' || this.#active) {
                    return { kind: 'rejected', reason: 'invalid' };
                }
                return this.#submit(cmd);
            case 'submit':
                return this.#submit(cmd);
            case 'steer':
                return this.#submit(cmd);
            case 'cancel':
                return this.#cancel();
            case 'cancellation_settled': {
                if (this.#phase !== 'cancelling' ||
                    !this.#cancellationUnproven ||
                    this.#active?.executionId !== cmd.executionId ||
                    this.#cancellationExecutionId !== cmd.executionId) {
                    return { kind: 'no_op' };
                }
                this.#active = undefined;
                this.#pendingAction = undefined;
                this.#cancellationUnproven = false;
                this.#cancellationExecutionId = null;
                if (this.#cancelRetainedItemIds.size === 0) {
                    this.#phase = 'idle';
                    this.#pauseReason = undefined;
                }
                else {
                    this.#phase = 'paused';
                    this.#pauseReason = 'manual';
                }
                this.#cancelRetainedItemIds.clear();
                await this.#persist();
                if (this.#phase === 'idle')
                    await this.#dispatch();
                return { kind: 'accepted' };
            }
            case 'answer_preflight': {
                if (this.#phase !== 'awaiting_preflight')
                    return { kind: 'rejected', reason: 'stale' };
                const head = this.#queue[0];
                if (head.id !== cmd.itemId || head.preflight?.actionId !== cmd.actionId) {
                    return { kind: 'rejected', reason: 'stale' };
                }
                if (!cmd.accepted) {
                    this.#queue.shift();
                    this.#phase = 'idle';
                    await this.#persist();
                    await this.#dispatch();
                    return { kind: 'accepted' };
                }
                return this.#acceptPreflight();
            }
            case 'resolve_tool_approval': {
                if (this.#phase !== 'awaiting_active_action')
                    return { kind: 'rejected', reason: 'stale' };
                if (this.#active.executionId !== cmd.executionId ||
                    this.#pendingAction.actionId !== cmd.actionId ||
                    this.#pendingAction.kind !== 'tool_approval') {
                    return { kind: 'rejected', reason: 'stale' };
                }
                return this.#resolveAction();
            }
            case 'answer_ask_user': {
                if (this.#phase !== 'awaiting_active_action')
                    return { kind: 'rejected', reason: 'stale' };
                if (this.#active.executionId !== cmd.executionId ||
                    this.#pendingAction.actionId !== cmd.actionId ||
                    this.#pendingAction.kind !== 'ask_user') {
                    return { kind: 'rejected', reason: 'stale' };
                }
                return this.#resolveAction();
            }
            case 'resume_queue':
                if (this.#phase !== 'paused')
                    return { kind: 'no_op' };
                this.#phase = 'idle';
                this.#pauseReason = undefined;
                await this.#persist();
                await this.#dispatch();
                return { kind: 'accepted' };
            case 'discard_queue':
                this.#queue = [];
                if (this.#phase === 'cancelling') {
                    // Discarding retained work during cancellation changes the stop's
                    // effective retention decision, but never releases active ownership.
                    this.#cancelRetainedItemIds.clear();
                }
                this.#releaseEmptyPause();
                await this.#persist();
                return { kind: 'accepted' };
            case 'edit_queued': {
                const index = this.#queue.findIndex((item) => item.id === cmd.itemId);
                if (index < 0 || !cmd.text.trim())
                    return { kind: 'rejected', reason: index < 0 ? 'not_queued' : 'invalid' };
                this.#queue[index] = freeze({ ...this.#queue[index], text: cmd.text });
                await this.#persist();
                return { kind: 'accepted' };
            }
            case 'remove_queued': {
                const index = this.#queue.findIndex((item) => item.id === cmd.itemId);
                if (index < 0)
                    return { kind: 'rejected', reason: 'not_queued' };
                this.#queue.splice(index, 1);
                this.#releaseEmptyPause();
                if (this.#phase === 'cancelling') {
                    this.#cancelRetainedItemIds.delete(cmd.itemId);
                }
                if (this.#phase === 'awaiting_preflight' && index === 0) {
                    this.#phase = 'idle';
                }
                await this.#persist();
                if (this.#phase === 'idle') {
                    await this.#dispatch();
                }
                return { kind: 'accepted' };
            }
            case 'change_execution_settings':
            case 'change_cosmetic_settings':
                await this.#persist();
                return { kind: 'accepted' };
        }
    }
    async #submit(cmd) {
        if (!cmd.text.trim())
            return { kind: 'rejected', reason: 'invalid' };
        if (this.#queue.length >= this.#capacity)
            return { kind: 'rejected', reason: 'capacity' };
        const id = cmd.id ?? this.#itemId();
        if (!isNonEmptyString(id) || this.#queue.some((item) => item.id === id) || this.#active?.item.id === id) {
            return { kind: 'rejected', reason: 'invalid' };
        }
        const item = freeze({
            id: id,
            text: cmd.text,
            sequence: this.#nextSequence++,
            submittedAt: this.#now(),
            ...(cmd.kind === 'steer' ? { steer: true } : {}),
        });
        if (cmd.kind === 'submit_held') {
            // Bootstrap belongs before every retained item (including released steers).
            this.#queue = [item, ...this.#queue].map((queued) => freeze({ ...queued, sequence: this.#nextSequence++ }));
            await this.#persist();
            this.#dispatchHeld = false;
            await this.#dispatch();
            return { kind: 'accepted' };
        }
        if (cmd.kind === 'steer') {
            // A steer that reaches the queue could not be delivered into the running
            // turn, so it runs as its own turn — ahead of the follow-ups queued
            // before it, which is the priority the user expressed by steering, and
            // behind steers they sent earlier, which is the order they said it in.
            const firstFollowUp = this.#queue.findIndex((queued) => !queued.steer);
            const insertAt = firstFollowUp < 0 ? this.#queue.length : firstFollowUp;
            this.#queue = [...this.#queue.slice(0, insertAt), item, ...this.#queue.slice(insertAt)].map((queued) => freeze({ ...queued, sequence: this.#nextSequence++ }));
            await this.#persist();
            await this.#dispatch();
            return { kind: 'accepted' };
        }
        this.#queue.push(item);
        await this.#persist();
        await this.#dispatch();
        return { kind: 'accepted' };
    }
    async event(event) {
        if (event.kind === 'tool_approval_requested' || event.kind === 'ask_user_requested') {
            if (!this.#active || this.#active.executionId !== event.executionId || this.#phase !== 'running')
                return;
            this.#pendingAction = {
                actionId: event.actionId,
                kind: event.kind === 'tool_approval_requested' ? 'tool_approval' : 'ask_user',
            };
            this.#phase = 'awaiting_active_action';
            await this.#persist();
            return;
        }
        if (!this.#active || this.#active.executionId !== event.executionId)
            return;
        const activeFromPhase = this.#phase === 'running' || this.#phase === 'awaiting_active_action';
        if (!activeFromPhase)
            return;
        if (event.kind === 'failed') {
            this.#active = undefined;
            this.#pendingAction = undefined;
            // Failure policy: do not auto-advance. Pause with retained work so the
            // user can resume or discard; only return to idle when nothing remains.
            if (this.#queue.length === 0) {
                this.#phase = 'idle';
                this.#pauseReason = undefined;
            }
            else {
                this.#phase = 'paused';
                this.#pauseReason = 'failure';
            }
            await this.#persist();
            return;
        }
        if (event.kind !== 'completed')
            return;
        this.#pendingAction = undefined;
        this.#phase = 'completing';
        await this.#persist();
        await this.#completionBarrier?.(event);
        if (this.#phase !== 'completing' || this.#active?.executionId !== event.executionId)
            return;
        this.#active = undefined;
        this.#phase = 'idle';
        await this.#persist();
        await this.#dispatch();
    }
    async #resolveAction() {
        this.#phase = 'running';
        this.#pendingAction = undefined;
        await this.#persist();
        return { kind: 'accepted' };
    }
    async #acceptPreflight() {
        const item = this.#queue.shift();
        const active = freeze({
            executionId: this.#executionId(),
            item,
            snapshot: freeze(structuredClone(this.#snapshotFactory(item))),
        });
        this.#active = active;
        this.#phase = 'running';
        await this.#persist();
        // Driver failure is handled by the 'failed' event handler (line ~473), not by
        // synchronous exceptions here. The driver returns void and kicks off async work.
        await this.#driver.start(active);
        return { kind: 'accepted' };
    }
    async #cancel() {
        if (this.#phase === 'paused' && this.#pauseReason === 'manual') {
            this.#phase = 'idle';
            this.#pauseReason = undefined;
            await this.#persist();
            await this.#dispatch();
            return { kind: 'accepted' };
        }
        if (this.#phase === 'awaiting_preflight') {
            this.#phase = 'paused';
            this.#pauseReason = 'manual';
            await this.#persist();
            return { kind: 'accepted' };
        }
        if (!this.#active || (this.#phase !== 'running' && this.#phase !== 'awaiting_active_action')) {
            if (this.#phase !== 'cancelling')
                return { kind: 'no_op' };
            return { kind: 'no_op' };
        }
        const active = this.#active;
        // Capture which work was already queued when the user stopped. A manual
        // pause exists only to retain that pre-existing work; items submitted
        // after the stop (including ones raced in while cancel cleanup awaits the
        // active turn) reflect fresh intent and must run, not stick behind an
        // empty pause with nothing to resume.
        this.#cancelRetainedItemIds = new Set(this.#queue.map((item) => item.id));
        this.#phase = 'cancelling';
        this.#cancellationUnproven = false;
        this.#cancellationExecutionId = active.executionId;
        this.#pendingAction = undefined;
        await this.#persist();
        let proven = true;
        try {
            proven = (await this.#driver.cancel(active)) !== false;
        }
        finally {
            if (this.#active?.executionId === active.executionId && proven) {
                this.#active = undefined;
                this.#cancellationExecutionId = null;
                // Invariant: a paused queue must contain retained work. When nothing
                // remains from stop time, return to idle so the next submission
                // starts immediately instead of being queued behind a manual pause
                // with nothing to resume. A submission raced in during cleanup is
                // dispatched below.
                if (this.#cancelRetainedItemIds.size === 0) {
                    this.#phase = 'idle';
                    this.#pauseReason = undefined;
                }
                else {
                    this.#phase = 'paused';
                    this.#pauseReason = 'manual';
                }
                this.#cancelRetainedItemIds.clear();
                await this.#persist();
                if (this.#phase === 'idle') {
                    await this.#dispatch();
                }
            }
            else if (!proven) {
                // Keep the active execution attached to the cancelling controller.
                // A caller that cannot prove cancellation must not observe an idle
                // queue capable of dispatching work alongside it.
                this.#cancellationUnproven = true;
                await this.#persist();
            }
        }
        return proven ? { kind: 'accepted' } : { kind: 'rejected', reason: 'cancellation_unproven' };
    }
    async #dispatch() {
        if (this.#dispatchHeld || this.#phase !== 'idle' || this.#active || this.#queue.length === 0)
            return;
        const head = this.#queue[0];
        // If the head already has a preflight (e.g. recovered), respect it.
        if (head.preflight) {
            this.#phase = 'awaiting_preflight';
            await this.#persist();
            return;
        }
        const preflight = this.#preflightEvaluator?.(head)?.preflight;
        if (preflight) {
            this.#queue[0] = freeze({ ...head, preflight: { actionId: preflight.actionId, kind: preflight.kind } });
            this.#phase = 'awaiting_preflight';
            await this.#persist();
            return;
        }
        const item = this.#queue.shift();
        const active = freeze({
            executionId: this.#executionId(),
            item,
            snapshot: freeze(structuredClone(this.#snapshotFactory(item))),
        });
        this.#active = active;
        this.#phase = 'running';
        await this.#persist();
        // Driver failure is handled by the 'failed' event handler (line ~473), not by
        // synchronous exceptions here. The driver returns void and kicks off async work.
        await this.#driver.start(active);
    }
    #restore() {
        if (!this.#persistence)
            return;
        let raw;
        try {
            raw = this.#persistence.load();
        }
        catch (error) {
            this.#recovery = {
                kind: 'invalid_persisted_queue',
                detail: error instanceof Error ? error.message : String(error),
            };
            void this.#quarantine();
            return;
        }
        if (raw === null || raw === undefined)
            return;
        const record = validatePersistedQueue(raw);
        if (typeof record === 'string') {
            this.#recovery = { kind: 'invalid_persisted_queue', detail: record };
            void this.#quarantine();
            return;
        }
        this.#nextSequence = record.nextSequence;
        this.#queue = record.queue.map((item) => {
            const queueItem = persistedItemToQueueItem(item);
            if (queueItem.preflight && !this.#preflightEvaluator) {
                return freeze({
                    ...queueItem,
                    preflight: {
                        actionId: this.#actionId(),
                        kind: queueItem.preflight.kind,
                    },
                });
            }
            return queueItem;
        });
        if (record.active) {
            // The interrupted active item is dropped, never replayed (C12.3): no
            // driver start, no tool/approval re-dispatch. Its execution id survives
            // only as a recovery diagnostic. When no queued work was retained, settle
            // idle rather than an empty paused controller that would block the
            // composer behind "0 item(s) pending" (C12.4).
            this.#recovery = { kind: 'recovered_interrupted', interruptedExecutionId: record.active.executionId };
            if (this.#queue.length > 0) {
                this.#phase = 'paused';
                this.#pauseReason = 'recovered_interrupted';
            }
            return;
        }
        if (record.pause) {
            this.#phase = 'paused';
            this.#pauseReason = record.pause.reason;
            this.#releaseEmptyPause();
            return;
        }
        if (this.#queue.length > 0) {
            this.#phase = 'paused';
            this.#pauseReason = 'recovered_interrupted';
        }
    }
    /** A pause retains queued work, never active cancellation ownership. */
    #releaseEmptyPause() {
        if (this.#phase !== 'paused' || this.#queue.length > 0)
            return;
        this.#phase = 'idle';
        this.#pauseReason = undefined;
    }
    async #persist() {
        if (!this.#persistence)
            return;
        const active = this.#active
            ? {
                executionId: this.#active.executionId,
                item: queueItemToPersisted(this.#active.item),
                snapshot: this.#active.snapshot,
                phase: this.#phase,
                ...(this.#pendingAction
                    ? {
                        pendingAction: {
                            actionId: this.#pendingAction.actionId,
                            kind: this.#pendingAction.kind,
                        },
                    }
                    : {}),
            }
            : undefined;
        const record = {
            version: 1,
            nextSequence: this.#nextSequence,
            queue: this.#queue.map((item) => queueItemToPersisted(item)),
            ...(this.#phase === 'paused' ? { pause: { reason: this.#pauseReason } } : {}),
            ...(active ? { active } : {}),
        };
        const write = this.#persistenceWrites.then(() => this.#persistence.replace(record));
        this.#persistenceWrites = write.then(() => undefined, () => undefined);
        try {
            await write;
        }
        catch (error) {
            this.#recovery = { kind: 'persistence_failed', detail: error instanceof Error ? error.message : String(error) };
        }
    }
    async #quarantine() {
        try {
            await this.#persistence?.quarantine?.();
        }
        catch {
            // Recovery state already reports the rejected record. Quarantine is best effort.
        }
    }
}
//# sourceMappingURL=queue-controller.js.map