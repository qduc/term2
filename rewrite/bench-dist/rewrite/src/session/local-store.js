import { projectNetworkFacts } from './adopted/network.js';
/** Canonical filesystem SessionStore. The source conversation log is its sole authority. */
import crypto from 'node:crypto';
import { captureAdoptedInput, } from './adopted/submission.js';
import fs from 'node:fs';
import { CanonicalSessionLog, auditCanonicalConversation, loadCanonicalConversation, normalizedBodyHash, } from './adopted/conversation-log.js';
import { SessionIndexService } from './adopted/conversation-index.js';
import { initialState, newestAdmission, projectLifecycle, statusFromLegacyAudit, withTranscript } from './reducer.js';
export class LocalSessionStore {
    #options;
    constructor(options) {
        this.#options = options;
    }
    async create(workspace, model, binding) {
        fs.mkdirSync(this.#options.root, { recursive: true });
        const id = `ses_${crypto.randomUUID()}`;
        return this.createWithId(id, workspace, model, binding);
    }
    /** Proof/adapter composition keeps the source runtime's already-selected ID. */
    async createWithId(id, workspace, model, binding, metadata = {}) {
        fs.mkdirSync(this.#options.root, { recursive: true });
        const log = CanonicalSessionLog.create({
            root: this.#options.root,
            id,
            metadata: { projectPath: workspace.root, model: model.model, provider: model.provider, ...metadata },
            workspace,
            model,
            ...(binding ? { binding } : {}),
            logger: this.#options.logger,
            fileSystem: this.#options.fileSystem,
        });
        return (await this.#makeSession(id, log, replayState(id, log, this.#options), false)).session;
    }
    async createAdopted(workspace, model, binding) {
        if (!this.#options.adoptedSubmissionFactory && !this.#options.adoptedHandleFactory)
            throw new Error('Adopted submission factory is required');
        if (this.#options.adoptedSubmissionFactory && this.#options.adoptedHandleFactory)
            throw new Error('Ambiguous adopted factories');
        fs.mkdirSync(this.#options.root, { recursive: true });
        const id = `ses_${crypto.randomUUID()}`;
        const log = CanonicalSessionLog.create({
            root: this.#options.root,
            id,
            metadata: { projectPath: workspace.root, model: model.model, provider: model.provider },
            workspace,
            model,
            ...(binding ? { binding } : {}),
            logger: this.#options.logger,
            fileSystem: this.#options.fileSystem,
        });
        try {
            return (await this.#makeSession(id, log, replayState(id, log, this.#options), true));
        }
        catch (error) {
            try {
                await log.dispose();
            }
            catch {
                // Preserve the original construction failure.
            }
            throw error;
        }
    }
    async open(id, expectedBinding) {
        return (await this.#open(id, expectedBinding, false)).session;
    }
    async openAdopted(id, expectedBinding) {
        if (!this.#options.adoptedSubmissionFactory && !this.#options.adoptedHandleFactory)
            throw new Error('Adopted submission factory is required');
        if (this.#options.adoptedSubmissionFactory && this.#options.adoptedHandleFactory)
            throw new Error('Ambiguous adopted factories');
        return this.#open(id, expectedBinding, true);
    }
    async #open(id, expectedBinding, adopted) {
        if (expectedBinding) {
            const existing = CanonicalSessionLog.readOnly(this.#options.root, id);
            const binding = existing.find((entry) => entry.fact.type === 'session_bound')?.fact;
            if (binding?.type !== 'session_bound' || !sameBinding(binding.binding, expectedBinding)) {
                throw new Error('session binding does not match the expected owner/workspace/grant');
            }
        }
        // Acquire the existing source writer lock before replay and reconciliation.
        const log = CanonicalSessionLog.open({
            root: this.#options.root,
            id,
            logger: this.#options.logger,
            fileSystem: this.#options.fileSystem,
        });
        try {
            let state = replayState(id, log, this.#options);
            if (state.status === 'closed')
                throw new Error(`session ${id} is closed`);
            const facts = [];
            for (const request of projectNetworkFacts(log.entries().map((entry) => entry.fact))) {
                facts.push({
                    type: 'session_network_resolved',
                    version: 1,
                    requestId: request.requestId,
                    generation: request.generation,
                    resolution: { kind: 'recovered', reason: 'process_restarted' },
                });
            }
            const pending = state.pendingInteraction;
            if (pending) {
                const identity = {
                    turnId: pending.turnId,
                    interactionId: pending.interaction.interactionId,
                    revision: pending.interaction.revision,
                    generation: pending.generation,
                };
                facts.push({ type: 'session_interaction_recovered', version: 1, ...identity, reason: 'daemon_restart' });
                const pendingFact = [...log.entries()]
                    .reverse()
                    .find((entry) => entry.fact.type === 'session_interaction_pending' && entry.fact.turnId === pending.turnId)?.fact;
                if (pendingFact?.type === 'session_interaction_pending' &&
                    pendingFact.settleOnRecovery === 'child_interrupted') {
                    facts.push({
                        type: 'subagent_interrupted',
                        agentId: pendingFact.child?.agentId ?? pending.interaction.descriptor.agentName,
                        role: pendingFact.child?.role ?? pending.interaction.descriptor.agentName,
                        finalText: 'Child interaction interrupted by daemon restart.',
                    });
                }
                facts.push({ type: 'session_interaction_resolved', version: 1, ...identity, outcome: 'cancelled' });
            }
            for (const admission of Object.values(state.admissions)) {
                if (admission.result)
                    continue;
                const started = log
                    .entries()
                    .some((entry) => entry.fact.type === 'session_turn_started' && entry.fact.turnId === admission.turnId);
                const terminal = [...log.entries()]
                    .reverse()
                    .find((entry) => entry.fact.type === 'session_turn_ended' && entry.fact.turnId === admission.turnId)?.fact;
                if (admission.disposition === 'queued' && !started && !terminal) {
                    facts.push({
                        type: 'session_admission_settled',
                        version: 1,
                        clientRequestId: admission.clientRequestId,
                        turnId: admission.turnId,
                        result: 'queue_discarded',
                    });
                }
                else if (terminal?.type === 'session_turn_ended') {
                    const result = terminal.outcome === 'completed' ? 'accepted' : terminal.outcome === 'cancelled' ? 'aborted' : 'failed';
                    facts.push({
                        type: 'session_admission_settled',
                        version: 1,
                        clientRequestId: admission.clientRequestId,
                        turnId: admission.turnId,
                        result,
                    });
                }
                else if (!terminal && (admission.disposition === 'started' || started)) {
                    facts.push({
                        type: 'session_admission_settled',
                        version: 1,
                        clientRequestId: admission.clientRequestId,
                        turnId: admission.turnId,
                        result: 'aborted',
                    });
                }
            }
            const priorInterrupt = log
                .entries()
                .some((entry) => entry.fact.type === 'session_interrupted' &&
                (state.activeTurnId === null || entry.fact.turnId === state.activeTurnId));
            if ((state.status === 'running' || state.status === 'awaiting_interaction' || state.status === 'interrupted') &&
                !priorInterrupt) {
                facts.push({
                    type: 'session_interrupted',
                    version: 1,
                    turnId: state.activeTurnId,
                    reason: 'daemon_restart',
                    interruptedAt: new Date().toISOString(),
                });
            }
            if (facts.length) {
                await log.append(facts);
                state = replayState(id, log, this.#options);
            }
            return await this.#makeSession(id, log, state, adopted);
        }
        catch (error) {
            await log.dispose();
            throw error;
        }
    }
    async list(cursor) {
        const names = fs.existsSync(this.#options.root)
            ? fs
                .readdirSync(this.#options.root)
                .filter((name) => name.endsWith('.jsonl'))
                .map((name) => name.slice(0, -6))
                .sort()
            : [];
        const start = cursor ? Math.max(0, names.findIndex((id) => id === cursor) + 1) : 0;
        const page = names.slice(start, start + 100);
        const sessions = [];
        for (const id of page) {
            const entries = CanonicalSessionLog.readOnly(this.#options.root, id);
            const state = replayState(id, { entries: () => entries }, this.#options, this.#options.root);
            sessions.push({
                id: state.id,
                status: state.status,
                workspace: state.workspace,
                lastSeq: state.lastSeq,
                title: state.messages.length
                    ? String(state.messages.at(-1)?.text ?? '').slice(0, 80) || null
                    : null,
                updatedAt: entries.at(-1)?.at ?? new Date(0).toISOString(),
            });
        }
        return { sessions, nextCursor: start + page.length < names.length && page.length ? page.at(-1) : null };
    }
    /** Delete only explicitly closed sessions whose fixed retention deadline has passed. */
    async expireClosed(now = new Date()) {
        const deleted = [];
        const errors = [];
        const names = fs.existsSync(this.#options.root)
            ? fs.readdirSync(this.#options.root).filter((name) => name.endsWith('.jsonl'))
            : [];
        for (const name of names) {
            const id = name.slice(0, -'.jsonl'.length);
            let snapshot;
            try {
                snapshot = CanonicalSessionLog.readOnly(this.#options.root, id);
            }
            catch (error) {
                errors.push({ id, message: error instanceof Error ? error.message : String(error) });
                continue;
            }
            if (!isRetentionEligible(snapshot, now.getTime()))
                continue;
            let locked;
            try {
                locked = CanonicalSessionLog.open({
                    root: this.#options.root,
                    id,
                    logger: this.#options.logger,
                    fileSystem: this.#options.fileSystem,
                });
                if (!isRetentionEligible(locked.entries(), now.getTime())) {
                    await locked.dispose();
                    continue;
                }
                await locked.deleteFiles();
                deleted.push(id);
            }
            catch (error) {
                if (locked) {
                    try {
                        await locked.dispose();
                    }
                    catch {
                        /* keep the original delete error */
                    }
                }
                errors.push({ id, message: error instanceof Error ? error.message : String(error) });
            }
        }
        if (deleted.length) {
            try {
                const result = await new SessionIndexService({
                    conversationsDir: this.#options.root,
                    backend: 'direct',
                }).reconcile();
                if (!result.ok)
                    errors.push({ id: '*index*', message: result.error ?? 'session index reconciliation failed' });
            }
            catch (error) {
                errors.push({ id: '*index*', message: error instanceof Error ? error.message : String(error) });
            }
        }
        return { deleted, errors };
    }
    async #makeSession(id, log, state, adopted) {
        let current = state;
        let mutationFailure;
        let constructing = true;
        let settingsReserved = false;
        let closingLog = false;
        const pendingAdmissions = new Map();
        const generation = crypto.randomUUID();
        let position = 0;
        const listeners = new Set();
        const queue = [];
        let delivering = false;
        const enqueue = (updates) => {
            for (const update of updates) {
                if (!Number.isSafeInteger(position + 1))
                    throw new Error('Session position exhausted');
                const item = { position: { generation, position: ++position }, update: structuredClone(update) };
                queue.push({ item, listeners: [...listeners] });
            }
            if (delivering)
                return;
            delivering = true;
            try {
                while (queue.length) {
                    const { item, listeners: targets } = queue.shift();
                    for (const listener of targets) {
                        if (!listeners.has(listener))
                            continue;
                        try {
                            const result = listener(item);
                            if (result != null &&
                                (typeof result === 'object' || typeof result === 'function') &&
                                typeof result.then === 'function')
                                void Promise.resolve(result).catch(() => { });
                        }
                        catch {
                            /* Observers cannot undo publication. */
                        }
                    }
                }
            }
            finally {
                delivering = false;
            }
        };
        const context = {
            id,
            root: log.root,
            log,
            state: () => current,
            reserveSettings: () => {
                if (settingsReserved || closingLog || mutationFailure !== undefined)
                    throw new Error('Session mutation is unavailable');
                settingsReserved = true;
                return () => {
                    settingsReserved = false;
                };
            },
            poison: (error) => {
                mutationFailure ??= error ?? new Error('Session mutation failed');
            },
            assertHealthy: () => {
                if (mutationFailure !== undefined)
                    throw mutationFailure;
            },
            commit: async (facts) => {
                if (mutationFailure !== undefined)
                    throw mutationFailure;
                const entries = await log.append(facts);
                for (const entry of entries)
                    current = projectLifecycle(current, entry);
                const restored = loadCanonicalConversation(id, log.root, 'live');
                current = withTranscript(current, { history: restored.history, messages: restored.messages }, restored.history);
                if (!constructing)
                    enqueue(entries.map((entry) => ({ kind: 'fact', entry })));
                if (mutationFailure !== undefined)
                    throw mutationFailure;
                return entries;
            },
        };
        const receipts = new Map();
        let handleClosed = false;
        const adoptedContext = {
            ...context,
            admit: async ({ requestId, input }, message) => {
                if (mutationFailure !== undefined)
                    throw mutationFailure;
                if (settingsReserved || closingLog)
                    throw new Error('Session mutation is in progress');
                if (handleClosed || current.status === 'closed')
                    return { kind: 'rejected', reason: 'closed' };
                const { input: owned, hash } = captureAdoptedInput(input);
                const ownedMessage = structuredClone(message);
                ownedMessage.text = owned.text;
                if (owned.skill)
                    ownedMessage.skill = structuredClone(owned.skill);
                else
                    delete ownedMessage.skill;
                ownedMessage.submittedTurn = structuredClone(owned);
                const pending = pendingAdmissions.get(requestId);
                if (pending) {
                    if (pending.hash !== hash)
                        return { kind: 'rejected', reason: 'request_conflict' };
                    await pending.admitted;
                    return { kind: 'duplicate', turnId: pending.turnId };
                }
                const prior = newestAdmission(current, requestId, Date.now());
                if (prior)
                    return prior.normalizedBodyHash === hash
                        ? { kind: 'duplicate', turnId: prior.turnId }
                        : { kind: 'rejected', reason: 'request_conflict' };
                const turnId = crypto.randomUUID();
                const createdAt = new Date().toISOString();
                const expiresAt = new Date(Date.now() + (this.#options.admissionTtlMs ?? 60_000)).toISOString();
                let resolveAdmitted;
                let rejectAdmitted;
                const admitted = new Promise((resolve, reject) => {
                    resolveAdmitted = resolve;
                    rejectAdmitted = reject;
                });
                // Observe rejection even when no duplicate waiter exists.
                void admitted.catch(() => { });
                pendingAdmissions.set(requestId, { hash, turnId, admitted });
                try {
                    const entries = await context.commit([
                        { type: 'user_message', message: ownedMessage },
                        {
                            type: 'session_admitted',
                            version: 1,
                            clientRequestId: requestId,
                            normalizedBodyHash: hash,
                            turnId,
                            disposition: 'started',
                            createdAt,
                            expiresAt,
                        },
                    ]);
                    const receipt = { requestId, turnId, userMessageRef: entries[0].ref, input: owned };
                    receipts.set(receipt, 'outstanding');
                    resolveAdmitted();
                    return { kind: 'admitted', receipt };
                }
                catch (error) {
                    rejectAdmitted(error);
                    throw error;
                }
                finally {
                    pendingAdmissions.delete(requestId);
                }
            },
            activate: async (receipt) => {
                const admission = current.admissions[receipt.requestId];
                if (current.status === 'closed' ||
                    receipts.get(receipt) !== 'outstanding' ||
                    !admission ||
                    admission.turnId !== receipt.turnId ||
                    admission.result ||
                    current.activeTurnId !== null)
                    throw new Error('Invalid or stale adopted admission receipt');
                receipts.set(receipt, 'activating');
                try {
                    await context.commit([
                        { type: 'session_turn_started', version: 1, turnId: receipt.turnId, clientRequestId: receipt.requestId },
                    ]);
                    receipts.set(receipt, 'activated');
                }
                catch (error) {
                    receipts.delete(receipt);
                    throw error;
                }
            },
        };
        const combined = adopted && this.#options.adoptedHandleFactory
            ? await this.#options.adoptedHandleFactory(adoptedContext)
            : undefined;
        constructing = false;
        const driver = combined?.driver ?? this.#options.driverFactory(context);
        const rawSubmission = adopted
            ? combined?.submission ?? this.#options.adoptedSubmissionFactory(adoptedContext)
            : undefined;
        const submission = rawSubmission && {
            networkApproval: rawSubmission.networkApproval,
            history: (command) => handleClosed ? Promise.reject(new Error('Session handle is closed')) : rawSubmission.history(command),
            listRewindTargets: () => handleClosed ? Promise.reject(new Error('Session handle is closed')) : rawSubmission.listRewindTargets(),
            submit: (...args) => handleClosed ? Promise.resolve({ kind: 'rejected', reason: 'closed' }) : rawSubmission.submit(...args),
            decide: (command) => {
                if (handleClosed)
                    return Promise.reject(new Error('Session handle is closed'));
                return rawSubmission.decide(command);
            },
            retry: (target) => handleClosed ? Promise.resolve({ kind: 'rejected', reason: 'closed' }) : rawSubmission.retry(target),
            setRuntimeSettings: (command) => {
                if (handleClosed)
                    return Promise.reject(new Error('Session handle is closed'));
                return rawSubmission.setRuntimeSettings(command);
            },
            interruptFromUser: () => {
                if (handleClosed)
                    return Promise.reject(new Error('Session handle is closed'));
                return rawSubmission.interruptFromUser();
            },
        };
        let closePromise;
        const ensureOpen = () => {
            if (handleClosed)
                throw new Error('Session handle is closed');
        };
        // Recovery-only drivers can intentionally omit live capabilities. Their
        // canonical facts still flow through the session-owned publication queue.
        const unsubscribeDriver = typeof driver.subscribe === 'function'
            ? driver.subscribe(current.lastSeq, (update) => {
                if (update.kind === 'live')
                    enqueue([update]);
            })
            : () => { };
        const subscribeCombined = (fromSeq, listener) => {
            ensureOpen();
            let stopped = false;
            let delivering = false;
            let lastSeq = fromSeq;
            const pending = [];
            const drain = () => {
                if (delivering)
                    return;
                delivering = true;
                try {
                    while (!stopped && pending.length) {
                        const update = pending.shift();
                        if (update.kind === 'fact') {
                            if (update.entry.seq <= lastSeq)
                                continue;
                            lastSeq = update.entry.seq;
                        }
                        try {
                            const result = listener(update);
                            if (result != null &&
                                (typeof result === 'object' || typeof result === 'function') &&
                                typeof result.then === 'function')
                                void Promise.resolve(result).catch(() => { });
                        }
                        catch {
                            /* Observer failure cannot undo durable work. */
                        }
                    }
                }
                finally {
                    delivering = false;
                }
            };
            const wrapped = (item) => {
                pending.push(structuredClone(item.update));
                drain();
            };
            listeners.add(wrapped);
            pending.push(...log
                .entries()
                .filter((entry) => entry.seq > fromSeq && entry.seq <= current.lastSeq)
                .map((entry) => ({ kind: 'fact', entry: structuredClone(entry) })));
            drain();
            return () => {
                stopped = true;
                listeners.delete(wrapped);
            };
        };
        const session = {
            id,
            state: () => current,
            submit: async (requestId, items) => {
                if (handleClosed || current.status === 'closed')
                    return { kind: 'rejected', reason: 'closed' };
                const hash = normalizedBodyHash(items);
                const pending = pendingAdmissions.get(requestId);
                if (pending) {
                    if (pending.hash !== hash)
                        return { kind: 'rejected', reason: 'request_conflict' };
                    await pending.admitted;
                    return { kind: 'duplicate', turnId: pending.turnId };
                }
                const prior = newestAdmission(current, requestId, Date.now());
                if (prior)
                    return prior.normalizedBodyHash === hash
                        ? { kind: 'duplicate', turnId: prior.turnId }
                        : { kind: 'rejected', reason: 'request_conflict' };
                if (adopted)
                    throw new Error('Use adopted submission.submit for new requests on this session');
                const turnId = crypto.randomUUID();
                const createdAt = new Date().toISOString();
                const expiresAt = new Date(Date.now() + (this.#options.admissionTtlMs ?? 60_000)).toISOString();
                const text = items
                    .map((item) => item.type === 'user_message'
                    ? item.content.map((part) => (part.type === 'text' ? part.text : '')).join('')
                    : '')
                    .join('\n');
                let resolveAdmitted;
                let rejectAdmitted;
                const admitted = new Promise((resolve, reject) => {
                    resolveAdmitted = resolve;
                    rejectAdmitted = reject;
                });
                pendingAdmissions.set(requestId, { hash, turnId, admitted });
                try {
                    const commit = context.commit([
                        { type: 'user_message', message: { id: crypto.randomUUID(), sender: 'user', text } },
                        {
                            type: 'session_admitted',
                            version: 1,
                            clientRequestId: requestId,
                            normalizedBodyHash: hash,
                            turnId,
                            disposition: 'started',
                            createdAt,
                            expiresAt,
                        },
                        { type: 'session_turn_started', version: 1, turnId, clientRequestId: requestId },
                    ]);
                    commit.then(resolveAdmitted, rejectAdmitted);
                    await commit;
                }
                catch (error) {
                    pendingAdmissions.delete(requestId);
                    throw error;
                }
                pendingAdmissions.delete(requestId);
                return driver.submit(requestId, items);
            },
            decide: (decision) => {
                ensureOpen();
                return driver.decide(decision);
            },
            cancel: () => {
                ensureOpen();
                return driver.cancel();
            },
            retry: () => {
                ensureOpen();
                return driver.retry();
            },
            compact: () => {
                ensureOpen();
                return driver.compact();
            },
            setModel: (model) => {
                ensureOpen();
                return driver.setModel(model);
            },
            subscribe: subscribeCombined,
            capture: (listener) => {
                ensureOpen();
                const snapshot = structuredClone(current);
                const captured = { generation, position };
                const wrapped = (update) => listener(structuredClone(update));
                listeners.add(wrapped);
                return {
                    state: snapshot,
                    position: captured,
                    unsubscribe: () => {
                        listeners.delete(wrapped);
                    },
                };
            },
            close: () => {
                if (closePromise)
                    return closePromise;
                handleClosed = true;
                closePromise = (async () => {
                    let failure;
                    try {
                        await combined?.shutdown();
                    }
                    catch (error) {
                        failure = error;
                    }
                    try {
                        await log.dispose();
                    }
                    catch (error) {
                        failure ??= error;
                    }
                    unsubscribeDriver();
                    listeners.clear();
                    if (failure !== undefined)
                        throw failure;
                })();
                return closePromise;
            },
            closeLog: async (closedAt = new Date().toISOString(), retentionEligibleAt = new Date(Date.parse(closedAt) + 30 * 86400000).toISOString()) => {
                ensureOpen();
                context.assertHealthy();
                if (settingsReserved || closingLog)
                    throw new Error('Session mutation is in progress');
                if (current.status === 'closed')
                    return;
                closingLog = true;
                try {
                    await combined?.closeNetwork?.();
                    await context.commit([{ type: 'session_closed', version: 1, closedAt, retentionEligibleAt }]);
                }
                finally {
                    closingLog = false;
                }
            },
        };
        return { session, ...(submission ? { submission } : {}) };
    }
}
function sameBinding(actual, expected) {
    return (!!actual &&
        actual.ownerUserId === expected.ownerUserId &&
        actual.workspaceId === expected.workspaceId &&
        actual.grantVersion === expected.grantVersion &&
        actual.fingerprint === expected.fingerprint);
}
function isRetentionEligible(entries, now) {
    const close = [...entries].reverse().find((entry) => entry.fact.type === 'session_closed')?.fact;
    return close?.type === 'session_closed' && Date.parse(close.retentionEligibleAt) <= now;
}
function replayState(id, log, options, explicitRoot) {
    const entries = log.entries();
    const binding = entries.find((entry) => entry.fact.type === 'session_bound')?.fact;
    const init = entries.find((entry) => entry.fact.type === 'session_init')?.fact;
    const workspace = binding?.type === 'session_bound'
        ? binding.workspace
        : {
            ...options.defaultWorkspace,
            ...(init?.type === 'session_init' && init.projectPath ? { root: init.projectPath } : {}),
        };
    const model = binding?.type === 'session_bound'
        ? binding.model
        : {
            ...options.defaultModel,
            ...(init?.type === 'session_init' && init.model ? { model: init.model } : {}),
            ...(init?.type === 'session_init' && init.provider ? { provider: init.provider } : {}),
        };
    let state = initialState(id, workspace, model);
    for (const entry of entries)
        state = projectLifecycle(state, entry);
    const root = explicitRoot ?? log.root;
    const restored = loadCanonicalConversation(id, root);
    state = withTranscript(state, { history: restored.history, messages: restored.messages }, restored.history);
    const audit = auditCanonicalConversation(id, explicitRoot ?? log.root);
    const hasLifecycleTurn = entries.some((entry) => entry.fact.type === 'session_turn_started' || entry.fact.type === 'session_interrupted');
    if (!hasLifecycleTurn)
        state = statusFromLegacyAudit(state, audit.outcome);
    return { ...state, lastSeq: entries.at(-1)?.seq ?? 0 };
}
//# sourceMappingURL=local-store.js.map