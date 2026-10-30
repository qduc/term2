import { normalizeObjectParams } from '../../lib/tool-invoke.js';
export class ToolApprovalPolicyRegistry {
    #policies = new Map();
    /** Number of registered tool policies; used to detect empty-graph miswiring. */
    get size() {
        return this.#policies.size;
    }
    register(registration) {
        this.#policies.set(registration.toolName, registration);
    }
    clear() {
        this.#policies.clear();
    }
    async evaluate(evaluation) {
        const policy = this.#policies.get(evaluation.toolName);
        if (!policy) {
            return { kind: 'unknown' };
        }
        try {
            const normalized = normalizeObjectParams(evaluation.args, policy.parameters);
            if (policy.checkInterceptors && (await policy.checkInterceptors(normalized, evaluation.context))) {
                return { kind: 'interceptor_denied' };
            }
            const requiresApproval = await policy.needsApproval(normalized, evaluation.context);
            return requiresApproval ? { kind: 'prompt' } : { kind: 'auto_approve' };
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const singleLine = message.replace(/[\r\n\t]+/g, ' ').slice(0, 300);
            return { kind: 'error', message: singleLine || 'Unknown approval policy error' };
        }
    }
    /**
     * Resolves the raw policy for a caller that cannot suspend for interactive
     * approval. Only an explicit auto-approval is executable out of band.
     */
    async decide(evaluation) {
        const result = await this.evaluate(evaluation);
        return result.kind === 'auto_approve' ? 'allow' : 'deny';
    }
}
export const toolApprovalPolicyRegistry = new ToolApprovalPolicyRegistry();
//# sourceMappingURL=tool-approval-policy-registry.js.map