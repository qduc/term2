import { getCallIdFromObject, getToolInfoFromInterruption } from '../interruption-info.js';
import { ApprovalDecisionExecutor } from './approval-decision-executor.js';
import { BackgroundSubagentApprovalQueue, } from './background-subagent-approval-queue.js';
/**
 * Session-owned policy/control boundary for approvals paused by adopted child
 * leases. Root ApprovalState is deliberately not involved: its continuation
 * belongs to the foreground turn, while this controller only touches the
 * continuation retained by the matching lease.
 */
export class BackgroundSubagentApprovalController {
    #queue = new BackgroundSubagentApprovalQueue();
    #executor;
    #toolOwnership;
    constructor({ logger, sessionId, toolOwnership, nestedCompatibility, }) {
        this.#toolOwnership = toolOwnership;
        this.#executor = new ApprovalDecisionExecutor({ logger, sessionId, toolOwnership, nestedCompatibility });
    }
    getSnapshot() {
        return this.#queue.getSnapshot();
    }
    subscribe(listener) {
        return this.#queue.subscribe(listener);
    }
    close() {
        return this.#queue.close();
    }
    removeRun(runId) {
        return this.#queue.removeRun(runId);
    }
    resolve(request) {
        return this.#queue.resolve(request);
    }
    /** Sink installed on the subagent runtime for pauses after a successful move. */
    publish = (pause) => {
        const { toolName, rawArguments } = getToolInfoFromInterruption(pause.interruption);
        const toolCallId = getCallIdFromObject(pause.interruption) ?? `${pause.runId}:${pause.generation}`;
        const entry = {
            runId: pause.runId,
            generation: pause.generation,
            toolCallId,
            toolName,
            argumentsText: typeof rawArguments === 'string' ? rawArguments : JSON.stringify(rawArguments ?? null),
        };
        this.#queue.enqueue(entry, {
            onResolve: (_entry, decision) => pause.apply((application) => this.#apply(application, pause.role, decision))
                ? { kind: 'applied' }
                : { kind: 'rejected' },
            onRelease: () => {
                // Queue closure/removal is terminal for this arbitration path. It must
                // not leave attribution for a pause the session no longer presents.
                this.#toolOwnership.release(toolCallId);
            },
        });
    };
    #apply(application, role, decision) {
        const pending = {
            state: application.handle,
            interruption: application.interruption,
            owner: { kind: 'subagent', agentId: application.runId, role },
        };
        this.#executor.resolve({
            pendingApprovalContext: pending,
            answer: decision.answer,
            rejectionReason: decision.rejectionReason,
        });
        return true;
    }
}
//# sourceMappingURL=background-subagent-approval-controller.js.map