import { resolveActiveEnforcement } from './profiles/index.js';
export const installPlanModeInterceptor = (agentClient, deps) => {
    // Subagent roles that cannot mutate the workspace (canWrite: false). The
    // `worker` role (and any future write-capable/custom role) is blocked.
    const READ_ONLY_SUBAGENT_ROLES = new Set(['explorer', 'mentor', 'librarian', 'reviewer']);
    const extractRole = (params) => {
        let obj = params;
        if (typeof obj === 'string') {
            try {
                obj = JSON.parse(obj);
            }
            catch {
                return undefined;
            }
        }
        const role = obj?.role;
        return typeof role === 'string' ? role : undefined;
    };
    const interceptor = async (name, params) => {
        const denials = resolveActiveEnforcement(deps.settingsService).denials;
        if (denials.has('filesystem-mutation') && ['create_file', 'search_replace', 'apply_patch'].includes(name)) {
            return `Plan mode is active (read-only). The "${name}" tool is disabled. Do not attempt file or state changes — investigate with read-only tools and present an ordered implementation plan. Tell the user to exit plan mode to execute it.`;
        }
        if (name === 'run_subagent' || name === 'run_subagent_async') {
            const role = extractRole(params);
            // Allow only read-only subagent roles; block worker and unknown roles
            // (an unknown role could be a write-capable custom subagent).
            if ((role !== undefined && !READ_ONLY_SUBAGENT_ROLES.has(role) && denials.has('delegated-write')) ||
                (role === undefined && denials.has('unknown-delegated-role'))) {
                return `Plan mode is active (read-only). The "${name}" tool is restricted to read-only roles (explorer, mentor, librarian, reviewer) — the "${role ?? 'unknown'}" role is disabled. Use a read-only subagent to investigate, then present an ordered implementation plan. Tell the user to exit plan mode to execute it.`;
            }
        }
        return null;
    };
    return agentClient.addToolInterceptor(interceptor);
};
//# sourceMappingURL=plan-mode-interceptor.js.map