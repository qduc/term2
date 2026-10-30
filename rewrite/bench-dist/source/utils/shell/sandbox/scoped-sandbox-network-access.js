import { ProjectNetworkAllowStore, SessionNetworkAllowStore } from './sandbox-network-store.js';
import { isSandboxNetworkHost, isSandboxNetworkPort } from './sandbox-network-validation.js';
/** A graph owns this capability, its allowlist, and the leased shell's pause target. */
export function createScopedSandboxNetworkAccess(options) {
    const sessionStore = new SessionNetworkAllowStore();
    const projectStore = new ProjectNetworkAllowStore(options.workspaceRoot);
    let closed;
    let controller;
    let pending = 0;
    let pauseOperations = Promise.resolve();
    const reservations = new Map();
    const operate = (target, action) => {
        if (!target)
            return;
        pauseOperations = pauseOperations.then(async () => {
            try {
                await target[action]();
            }
            catch {
                /* shell owns cleanup */
            }
        });
    };
    const registerPauseController = (target) => {
        if (closed)
            return () => { };
        controller = target;
        if (pending > 0)
            operate(target, 'pause');
        return () => {
            if (controller === target)
                controller = undefined;
        };
    };
    const dispose = (reason = 'closed') => {
        if (closed)
            return;
        closed = reason;
        for (const reservation of reservations.values()) {
            reservation.reason = reason;
            reservation.abort.abort();
        }
        if (pending > 0)
            operate(controller, 'resume');
        controller = undefined;
    };
    const request = async (request) => {
        if (!request || typeof request !== 'object')
            return false;
        const { host, port } = request;
        if (closed ||
            options.isLive?.() === false ||
            !isSandboxNetworkHost(host) ||
            (port !== undefined && !isSandboxNetworkPort(port)))
            return false;
        if (sessionStore.isAllowed(host, port) || projectStore.isAllowed(host, port))
            return true;
        const reservation = { abort: new AbortController(), reason: 'cancelled' };
        reservations.set(request, reservation);
        let settle;
        const completion = new Promise((resolve) => {
            settle = resolve;
        });
        if (++pending === 1)
            operate(controller, 'pause');
        let onAbort;
        const cancellation = new Promise((_, reject) => {
            onAbort = () => reject(new Error('closed'));
            reservation.abort.signal.addEventListener('abort', onAbort, { once: true });
        });
        try {
            const answer = await Promise.race([
                options.requestApproval(request, completion, reservation.abort.signal),
                cancellation,
            ]);
            if (reservation.abort.signal.aborted || closed || options.isLive?.() === false) {
                settle({ kind: 'failed', reason: reservation.abort.signal.aborted ? reservation.reason : closed ?? 'closed' });
                return false;
            }
            const allowed = answer === true || answer === 'allow-once' || answer === 'allow-session' || answer === 'allow-project';
            const entry = port != null && port !== 80 && port !== 443 ? `${host}:${port}` : host;
            if (answer === 'allow-session')
                sessionStore.add(entry);
            if (answer === 'allow-project')
                projectStore.append(entry);
            settle({ kind: 'applied', allowed });
            return allowed;
        }
        catch {
            settle({ kind: 'failed', reason: reservation.abort.signal.aborted ? reservation.reason : 'grant_failed' });
            return false;
        }
        finally {
            reservation.abort.signal.removeEventListener('abort', onAbort);
            reservations.delete(request);
            if (--pending === 0 && !closed)
                operate(controller, 'resume');
        }
    };
    const cancel = (request, reason = 'cancelled') => {
        const reservation = reservations.get(request);
        if (!reservation || reservation.abort.signal.aborted)
            return false;
        reservation.reason = reason;
        reservation.abort.abort();
        return true;
    };
    const cancelAll = (reason = 'cancelled') => {
        for (const request of reservations.keys())
            cancel(request, reason);
    };
    return { request, registerPauseController, cancel, cancelAll, dispose };
}
//# sourceMappingURL=scoped-sandbox-network-access.js.map