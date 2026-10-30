import { createPostExecutePausePolicy } from './post-execute-pause-policy.js';
/**
 * Session-owned construction capability. It is deliberately supplied only to
 * the root AgentClient: nested/subagent tool factories retain their existing
 * behavior until a later slice gives them an explicit ownership model.
 */
export class PostExecutePauseCapability {
    pending;
    #activeRunId = null;
    constructor(pending) {
        this.pending = pending;
    }
    setActiveRunId(runId) {
        this.#activeRunId = runId;
    }
    forTool(definition) {
        if (!definition.postExecutePause)
            return undefined;
        return createPostExecutePausePolicy({
            pending: this.pending,
            runId: () => this.#activeRunId,
            describe: definition.postExecutePause.describe,
            resolve: definition.postExecutePause.resolve,
        });
    }
}
//# sourceMappingURL=post-execute-pause-capability.js.map