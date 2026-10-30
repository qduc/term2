import { addAllowedHost, isHostAllowed } from './sandbox-network-store.js';
let activeHandler = null;
let activePauseController = null;
export function registerSandboxNetworkApprovalHandler(handler) {
    activeHandler = handler;
    return () => {
        if (activeHandler === handler) {
            activeHandler = null;
        }
    };
}
export function registerSandboxNetworkApprovalPauseController(controller) {
    activePauseController = controller;
    return () => {
        if (activePauseController === controller) {
            activePauseController = null;
        }
    };
}
async function pauseActiveSandboxedCommand() {
    try {
        await activePauseController?.pause();
    }
    catch {
        // Approval must still be shown even if process suspension is unavailable.
    }
}
async function resumeActiveSandboxedCommand() {
    try {
        await activePauseController?.resume();
    }
    catch {
        // Ignore resume errors; the shell execution path still owns process cleanup.
    }
}
export async function requestSandboxNetworkApproval(request) {
    if (isHostAllowed(request.host, request.port)) {
        return true;
    }
    if (!activeHandler) {
        return false;
    }
    await pauseActiveSandboxedCommand();
    try {
        const answer = await activeHandler(request);
        if (answer === true || answer === 'allow-once') {
            return true;
        }
        if (answer === 'allow-session') {
            addAllowedHost(request.host, request.port, 'session');
            return true;
        }
        if (answer === 'allow-project') {
            addAllowedHost(request.host, request.port, 'project');
            return true;
        }
        return false;
    }
    catch {
        return false;
    }
    finally {
        await resumeActiveSandboxedCommand();
    }
}
//# sourceMappingURL=sandbox-network-approval.js.map