import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { JsonlSessionLog } from './jsonl-log.js';
import { initialState, project } from './reducer.js';
const newId = (prefix) => `${prefix}_${crypto.randomUUID()}`;
/** Sessions as JSONL files under one directory. */
export class NativeTracerStore {
    #options;
    constructor(options) {
        this.#options = options;
        fs.mkdirSync(options.root, { recursive: true });
    }
    async create(workspace, model) {
        const id = newId('ses');
        const session = new NativeTracerSession(id, new JsonlSessionLog(this.#file(id)), [], this.#options);
        await session.commit([{ type: 'session_created', workspace, model }]);
        return session;
    }
    async open(id) {
        const file = this.#file(id);
        if (!fs.existsSync(file))
            throw new Error(`no session ${id}`);
        const log = new JsonlSessionLog(file);
        const entries = [];
        for await (const entry of log.read())
            entries.push(entry);
        const session = new NativeTracerSession(id, log, entries, this.#options);
        await session.reconcile();
        return session;
    }
    async list() {
        const sessions = [];
        for (const name of fs.readdirSync(this.#options.root)) {
            if (!name.endsWith('.jsonl'))
                continue;
            const id = name.slice(0, -'.jsonl'.length);
            const log = new JsonlSessionLog(this.#file(id));
            let state = initialState(id);
            let updatedAt = '';
            for await (const entry of log.read()) {
                state = project(state, entry);
                updatedAt = entry.at;
            }
            sessions.push({
                id,
                status: state.status,
                workspace: state.workspace,
                lastSeq: state.lastSeq,
                title: null,
                updatedAt,
            });
        }
        return { sessions, nextCursor: null };
    }
    #file(id) {
        if (!/^ses_[0-9a-f-]{36}$/.test(id))
            throw new Error('invalid session id');
        return path.join(this.#options.root, `${id}.jsonl`);
    }
}
class NativeTracerSession {
    id;
    #log;
    #options;
    #entries;
    #listeners = new Set();
    #seenRequests = new Map();
    #state;
    #run = null;
    constructor(id, log, entries, options) {
        this.id = id;
        this.#log = log;
        this.#options = options;
        this.#entries = [...entries];
        this.#state = entries.reduce(project, initialState(id));
        for (const entry of entries) {
            if (entry.fact.type === 'turn_started' && entry.fact.requestId) {
                this.#seenRequests.set(entry.fact.requestId, entry.fact.turnId);
            }
        }
    }
    state() {
        return this.#state;
    }
    async submit(requestId, items) {
        const seen = this.#seenRequests.get(requestId);
        if (seen)
            return { kind: 'duplicate', turnId: seen };
        if (this.#state.status === 'closed')
            return { kind: 'rejected', reason: 'closed' };
        // The tracer has no queue: a busy session refuses instead of queueing.
        if (this.#state.status === 'running' || this.#state.status === 'awaiting_interaction') {
            return { kind: 'rejected', reason: 'queue_full' };
        }
        const turnId = newId('turn');
        this.#seenRequests.set(requestId, turnId);
        await this.commit([
            { type: 'turn_started', turnId, requestId },
            ...items.map((item) => ({ type: 'item_committed', turnId, item })),
        ]);
        this.#startTurn(turnId);
        return { kind: 'started', turnId };
    }
    async decide(interactionId, decisions) {
        const pending = this.#state.pendingInteraction;
        const checkpoint = this.#state.lastCheckpoint;
        if (!pending || pending.interactionId !== interactionId || !checkpoint)
            throw new Error('stale interaction');
        await this.commit([{ type: 'interaction_resolved', interactionId, decisions }]);
        this.#drive(this.#options.engine.resume(checkpoint, new Map(decisions.map((d) => [d.callId, d.decision]))));
    }
    async cancel() {
        this.#run?.cancel();
    }
    async retry() {
        if (!this.#state.canRetry)
            return { kind: 'rejected', reason: 'closed' };
        const turnId = newId('turn');
        await this.commit([{ type: 'turn_started', turnId, requestId: null }]);
        this.#startTurn(turnId);
        return { kind: 'started', turnId };
    }
    async compact() {
        throw new Error('compaction is not part of the tracer');
    }
    async setModel(model) {
        await this.commit([{ type: 'model_changed', model }]);
    }
    subscribe(fromSeq, listener) {
        for (const entry of this.#entries)
            if (entry.seq > fromSeq)
                listener({ kind: 'fact', entry });
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }
    async close() {
        this.#run?.cancel();
        this.#listeners.clear();
    }
    /** The fixture never claims that native engine checkpoints survive process restart. */
    async reconcile() {
        const { status } = this.#state;
        if (status !== 'running' && status !== 'awaiting_interaction')
            return;
        const activeTurnId = this.#state.activeTurnId ?? this.#state.pendingInteraction?.turnId;
        if (!activeTurnId)
            return;
        await this.commit([
            { type: 'turn_interrupted', turnId: activeTurnId, reason: 'process stopped; native continuation is not resumed' },
        ]);
    }
    async commit(facts) {
        const seqs = await this.#log.append(facts);
        const at = new Date().toISOString();
        facts.forEach((fact, index) => {
            const entry = { seq: seqs[index], at, fact };
            this.#entries.push(entry);
            this.#state = project(this.#state, entry);
            this.#emit({ kind: 'fact', entry });
        });
    }
    #startTurn(turnId) {
        this.#drive(this.#options.engine.start({
            turnId,
            history: this.#state.history,
            newItems: [],
            instructions: this.#options.instructions,
            model: this.#state.model,
            toolNames: this.#options.tools
                .available({ workspace: this.#state.workspace, settings: this.#options.settings })
                .map((tool) => tool.spec.name),
            workspace: this.#state.workspace,
            budget: this.#options.budget,
        }));
    }
    /** Runs a turn to its end, turning each step boundary into one atomic append. */
    #drive(run) {
        this.#run = run;
        void (async () => {
            let items = [];
            for await (const event of run.events) {
                switch (event.type) {
                    case 'item':
                        items.push({ type: 'item_committed', turnId: run.turnId, item: event.item });
                        break;
                    case 'checkpoint':
                        await this.commit([...items, { type: 'checkpoint_saved', checkpoint: event.checkpoint }]);
                        items = [];
                        break;
                    case 'turn_ended': {
                        const outcome = event.outcome;
                        if (outcome.kind === 'suspended') {
                            await this.commit([
                                ...items,
                                { type: 'checkpoint_saved', checkpoint: outcome.checkpoint },
                                {
                                    type: 'interaction_opened',
                                    turnId: run.turnId,
                                    interactionId: newId('int'),
                                    approvals: outcome.approvals,
                                },
                            ]);
                        }
                        else {
                            const ended = outcome.kind === 'completed' ? 'completed' : outcome.kind;
                            await this.commit([...items, { type: 'turn_ended', turnId: run.turnId, outcome: ended }]);
                        }
                        items = [];
                        break;
                    }
                    default:
                        this.#emit({ kind: 'live', turnId: run.turnId, event });
                }
            }
            if (this.#run === run)
                this.#run = null;
        })();
    }
    #emit(update) {
        for (const listener of this.#listeners)
            listener(update);
    }
}
//# sourceMappingURL=local-store.js.map