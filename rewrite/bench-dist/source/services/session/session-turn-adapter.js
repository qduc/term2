import { contextCompactionFailureCategory } from '../../providers/openai-responses-model.js';
import { resolveSessionId } from './session-identity.js';
import { LiveRun } from './live-run.js';
import { SessionTurnDomain } from './session-turn-domain.js';
export class SessionTurnAdapter {
    deps;
    #liveRun = null;
    #domain;
    #nextLiveRunId = 0;
    #hookTurnId;
    #pending;
    constructor(deps) {
        this.deps = deps;
    }
    openTurn() {
        this.deps.agentClient.openTurn?.();
    }
    closeTurn() {
        this.deps.agentClient.closeTurn?.();
    }
    steer(items, options) {
        return this.deps.agentClient.steer?.(items, options) ?? Promise.resolve('released');
    }
    retractSteer(id) {
        return this.deps.agentClient.retractSteer?.(id) ?? false;
    }
    editSteer(id, items) {
        return this.deps.agentClient.editSteer?.(id, items) ?? false;
    }
    setHookTurnId(id) {
        this.#hookTurnId = id;
        this.#domain?.setHookTurnId(id);
    }
    async *executeInitial(input, options = {}) {
        if (this.#liveRun)
            throw new Error('A conversation turn is already active');
        const domain = new SessionTurnDomain(this.deps);
        this.#domain = domain;
        domain.setHookTurnId(this.#hookTurnId);
        const runId = `${resolveSessionId(this.deps.sessionId)}:live:${++this.#nextLiveRunId}`;
        this.#liveRun = new LiveRun(runId, this.deps.postExecutePending, async (emit) => {
            const bound = domain.beginAdoptedTurn(input, emit, options, (terminal, address, signal, generation) => new Promise((resolve, reject) => {
                const abort = () => {
                    this.#pending = undefined;
                    reject(Object.assign(new Error('Operation aborted'), { name: 'AbortError' }));
                };
                this.#pending = {
                    address,
                    generation,
                    resolve: (value) => {
                        signal.removeEventListener('abort', abort);
                        resolve(value);
                    },
                    reject: (error) => {
                        signal.removeEventListener('abort', abort);
                        reject(error);
                    },
                };
                signal.addEventListener('abort', abort, { once: true });
                if (signal.aborted)
                    abort();
                else
                    this.#liveRun.pause(terminal);
            }), runId);
            try {
                await this.deps.agentClient.runTurn(bound.session);
                return bound.finish();
            }
            catch (error) {
                const failure = contextCompactionFailureCategory(error);
                if (failure) {
                    const event = domain.compactionFailureEvent(failure);
                    if (event)
                        emit(event);
                }
                bound.finish();
                throw error;
            }
        });
        return yield* this.#observe();
    }
    async *executeContinuation(init, policy) {
        const pending = this.#pending;
        if (!pending)
            throw new Error('No conversation decision is waiting');
        const address = init.kind === 'approval_decision' ? init.decisionAddress : init.abortedContext.interruption;
        if (address !== pending.address ||
            init.generation !== pending.generation ||
            !this.deps.generationGuard.isCurrent(pending.generation))
            throw new Error('Conversation decision is stale');
        this.#pending = undefined;
        this.#liveRun?.resume();
        pending.resolve({ init, policy });
        return yield* this.#observe();
    }
    async *continuePostExecute() {
        return yield* this.#observe();
    }
    async *#observe() {
        const live = this.#liveRun;
        if (!live)
            throw new Error('No active conversation turn');
        let waiting = false;
        let completed = false;
        try {
            while (true) {
                const next = await live.next();
                if (next.kind === 'event') {
                    yield next.event;
                    continue;
                }
                if (next.kind === 'approval_required') {
                    waiting = true;
                    this.#domain?.resetCompactionFailure();
                    return { kind: 'approval_required', terminal: next.terminal };
                }
                if (next.kind === 'post_execute_approval_required') {
                    waiting = true;
                    return { kind: 'approval_required', terminal: this.#domain.postExecuteApprovalTerminal(next.entries) };
                }
                if (next.kind === 'cancelled')
                    return { kind: 'stale' };
                this.#domain?.resetCompactionFailure();
                completed = true;
                return next.result;
            }
        }
        finally {
            if (!waiting && this.#liveRun === live) {
                if (!completed)
                    await this.abortLiveRun();
                else {
                    this.#liveRun = null;
                    await live.completion.catch(() => undefined);
                }
            }
        }
    }
    abortLiveRun() {
        const live = this.#liveRun;
        this.#liveRun = null;
        this.#pending?.reject(Object.assign(new Error('Operation aborted'), { name: 'AbortError' }));
        this.#pending = undefined;
        live?.cancel();
        this.deps.agentClient.abort();
        return (live?.completion.then(() => undefined, () => undefined) ?? Promise.resolve());
    }
    get activePostExecuteRunId() {
        return this.#liveRun?.runId ?? null;
    }
}
//# sourceMappingURL=session-turn-adapter.js.map