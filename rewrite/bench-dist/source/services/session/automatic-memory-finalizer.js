import { randomUUID } from 'node:crypto';
import { resolveSessionId } from './session-identity.js';
/** Shared per-graph automatic-memory policy and storage-failure latch. */
export class AutomaticMemoryFinalizer {
    deps;
    #automaticMemory;
    constructor(deps) {
        this.deps = deps;
        this.#automaticMemory = deps.automaticMemory;
    }
    async *record(input) {
        if (!this.#automaticMemory || !this.deps.sessionId || this.deps.automaticMemoryAllowed?.() === false)
            return;
        if (typeof input !== 'string' && (input.images?.length || input.skill))
            return;
        const text = typeof input === 'string' ? input : input.text;
        try {
            const receipt = await this.#automaticMemory.record(text, resolveSessionId(this.deps.sessionId));
            if (!receipt)
                return;
            yield {
                type: 'command_message',
                message: {
                    id: `memory-${receipt.id}`,
                    sender: 'command',
                    status: 'completed',
                    command: 'Automatic memory canary',
                    output: `Learned (project): ${receipt.quote}\nSource session: ${receipt.sourceSessionId}\nReview with memory_get({scope:"project",id:"${receipt.id}"}); undo with ${receipt.undo}`,
                    success: true,
                    toolName: 'automatic_memory',
                    callId: `memory-${receipt.id}`,
                },
            };
        }
        catch {
            this.#automaticMemory = undefined;
            yield {
                type: 'command_message',
                message: {
                    id: `memory-error-${randomUUID()}`,
                    sender: 'command',
                    status: 'failed',
                    command: 'Automatic memory canary disabled',
                    output: 'Automatic memory stopped after a storage error. No further automatic writes will be attempted in this session; review the memory index before retrying.',
                    success: false,
                    toolName: 'automatic_memory',
                },
            };
        }
    }
}
//# sourceMappingURL=automatic-memory-finalizer.js.map