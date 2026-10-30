import { randomUUID } from 'node:crypto';
import { SandboxNetworkApprovalCoordinator } from '../../../../source/utils/shell/sandbox/sandbox-network-approval-coordinator.js';
import { isNetworkAnswer } from './network.js';
/** Private session authority; the canonical log remains the only durable writer. */
export function createNetworkAuthority(context, failClosed, cancelSource = () => { }) {
    const generation = randomUUID();
    const coordinator = new SandboxNetworkApprovalCoordinator();
    const entries = new Map();
    const applying = new Set();
    const listeners = new Set();
    let queue = Promise.resolve();
    let closed = false;
    let closePromise;
    let stopReason = 'execution_ended';
    let poisoned = false;
    let visible;
    let queued = 0;
    let pendingRequests = 0;
    const decisions = new Map();
    const serial = (fn) => {
        const result = queue.then(fn);
        queue = result.then(() => { }, () => { });
        return result;
    };
    const publish = () => {
        const active = coordinator.getSnapshot().activeRequest;
        visible = active ? entries.get(active) : undefined;
        queued = Math.max(0, entries.size - (visible ? 1 : 0));
        for (const listener of listeners) {
            try {
                const result = listener();
                if (result && typeof result.then === 'function')
                    void Promise.resolve(result).catch(() => { });
            }
            catch {
                /* Subscribers cannot undo durable state. */
            }
        }
    };
    const poison = () => {
        poisoned = true;
        coordinator.dispose();
        entries.clear();
        publish();
        failClosed();
    };
    const healthy = () => {
        try {
            context.assertHealthy();
            return true;
        }
        catch {
            return false;
        }
    };
    const requestApproval = async (request, completion, signal) => {
        const { host, port } = request;
        pendingRequests++;
        try {
            let answer;
            await serial(async () => {
                context.assertHealthy();
                if (closed || poisoned || context.state().status === 'closed' || signal.aborted)
                    return;
                const entry = {
                    id: randomUUID(),
                    request,
                    completion,
                    signal,
                    host,
                    ...(port === undefined ? {} : { port }),
                };
                try {
                    await context.commit([
                        {
                            type: 'session_network_requested',
                            version: 1,
                            requestId: entry.id,
                            generation,
                            host: entry.host,
                            ...(entry.port === undefined ? {} : { port: entry.port }),
                        },
                    ]);
                    context.assertHealthy();
                    if (signal.aborted || closed || context.state().status === 'closed') {
                        await context.commit([
                            {
                                type: 'session_network_resolved',
                                version: 1,
                                requestId: entry.id,
                                generation,
                                resolution: { kind: 'cancelled', reason: stopReason },
                            },
                        ]);
                        return;
                    }
                    entries.set(request, entry);
                    answer = coordinator.request(request);
                    publish();
                }
                catch (error) {
                    poison();
                    throw error;
                }
            });
            return answer ? await answer : 'deny';
        }
        finally {
            pendingRequests--;
        }
    };
    const cancelAll = async (reason) => {
        stopReason = reason;
        for (const entry of applying) {
            cancelSource(entry.request, reason === 'helper_lost' ? 'helper_lost' : reason === 'execution_ended' ? 'cancelled' : 'closed');
        }
        return serial(async () => {
            for (const entry of [...entries.values()]) {
                try {
                    await context.commit([
                        {
                            type: 'session_network_resolved',
                            version: 1,
                            requestId: entry.id,
                            generation,
                            resolution: { kind: 'cancelled', reason },
                        },
                    ]);
                }
                catch (error) {
                    poison();
                    throw error;
                }
                cancelSource(entry.request, reason === 'helper_lost' ? 'helper_lost' : reason === 'execution_ended' ? 'cancelled' : 'closed');
                coordinator.cancel(entry.request);
                entries.delete(entry.request);
            }
            publish();
        });
    };
    const decide = (command) => {
        if (!command ||
            typeof command !== 'object' ||
            Object.keys(command).some((key) => !['requestId', 'generation', 'answer'].includes(key)) ||
            typeof command.requestId !== 'string' ||
            typeof command.generation !== 'string' ||
            !isNetworkAnswer(command.answer))
            return Promise.reject(new Error('Malformed network decision'));
        try {
            context.assertHealthy();
        }
        catch (error) {
            return Promise.reject(error);
        }
        const owned = { requestId: command.requestId, generation: command.generation, answer: command.answer };
        if (closed || poisoned || context.state().status === 'closed')
            return Promise.reject(new Error('Network authority is closed'));
        const previous = decisions.get(owned.requestId);
        if (previous)
            return owned.generation === generation && owned.answer === previous.answer
                ? previous.result
                : Promise.reject(new Error('Conflicting network decision'));
        const result = serial(async () => {
            context.assertHealthy();
            const entry = visible;
            if (closed ||
                poisoned ||
                context.state().status === 'closed' ||
                !entry ||
                owned.requestId !== entry.id ||
                owned.generation !== generation ||
                !isNetworkAnswer(owned.answer))
                throw new Error('Stale network decision');
            try {
                await context.commit([
                    {
                        type: 'session_network_resolved',
                        version: 1,
                        requestId: entry.id,
                        generation,
                        resolution: { kind: 'answered', answer: owned.answer },
                    },
                ]);
            }
            catch (error) {
                poison();
                throw error;
            }
            context.assertHealthy();
            entries.delete(entry.request);
            if (entry.signal.aborted || closed || context.state().status === 'closed') {
                coordinator.cancel(entry.request);
                publish();
                return { kind: 'failed', reason: 'cancelled' };
            }
            applying.add(entry);
            try {
                coordinator.resolve(entry.request, owned.answer);
                publish();
                const completed = await entry.completion;
                context.assertHealthy();
                return completed;
            }
            finally {
                applying.delete(entry);
            }
        });
        decisions.set(owned.requestId, { answer: owned.answer, result });
        void result.catch(() => {
            if (decisions.get(owned.requestId)?.result === result)
                decisions.delete(owned.requestId);
        });
        return result;
    };
    return {
        requestApproval,
        isLive: () => healthy() && !closed && !poisoned && context.state().status !== 'closed',
        hasPending: () => pendingRequests > 0,
        cancelAll,
        decide,
        getSnapshot: () => ({
            active: visible
                ? {
                    requestId: visible.id,
                    generation,
                    choices: ['deny', 'allow-once', 'allow-session', 'allow-project'],
                    host: visible.host,
                    ...(visible.port === undefined ? {} : { port: visible.port }),
                }
                : null,
            queued,
        }),
        subscribe: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        close() {
            if (closePromise)
                return closePromise;
            closed = true;
            closePromise = (async () => {
                try {
                    await cancelAll('session_closed');
                }
                finally {
                    coordinator.dispose();
                    listeners.clear();
                }
            })();
            return closePromise;
        },
    };
}
//# sourceMappingURL=network-authority.js.map