import { isBareProfile } from '../../prompts/prompt-constructor.js';
import { profileEnterNotice, profileExitNotice } from '../mode-notices.js';
import { resolveActiveProfile } from './active-profile.js';
import { BUILTIN_INTEGRATIONS } from './registry.js';
import { resolveProfile } from './resolver.js';
/** The interactive runtime exposes all built-in integration points. */
const DEFAULT_AVAILABLE_INTEGRATIONS = new Map(BUILTIN_INTEGRATIONS.map((id) => [id, true]));
const resolveOptions = (deps) => ({
    availableIntegrations: deps.availableIntegrations ?? DEFAULT_AVAILABLE_INTEGRATIONS,
});
const isProfile = (profile, id) => profile.identity.id === id;
/**
 * Classify the runtime impact of changing between two resolved Profiles.
 * Identity equality intentionally wins: re-selecting a Profile has no effects,
 * even when that Profile itself carries a workflow notice.
 */
export function classifyProfileTransition(current, target) {
    if (current.identity.id === target.identity.id)
        return 'noop';
    if (isBareProfile(current) !== isBareProfile(target))
        return 'structural';
    const agentWorkflowInvolved = isProfile(current, 'builtin:mentor') ||
        isProfile(target, 'builtin:mentor') ||
        isProfile(current, 'builtin:orchestrator') ||
        isProfile(target, 'builtin:orchestrator');
    if (agentWorkflowInvolved)
        return 'agent-rebuild';
    const planInvolved = isProfile(current, 'builtin:plan') || isProfile(target, 'builtin:plan');
    if (planInvolved)
        return 'notice-only';
    const pairNoticeOnly = [current, target].every((profile) => ['builtin:standard', 'builtin:pair'].includes(profile.identity.id));
    if (pairNoticeOnly)
        return 'notice-only';
    // A non-built-in Profile cannot be assumed to have a stable prompt/tool
    // shape. Rebuild it conservatively rather than allowing stale composition.
    return 'agent-rebuild';
}
const composeNotice = (exitNotice, enterNotice) => {
    if (exitNotice && enterNotice)
        return `${exitNotice}\n\n${enterNotice}`;
    return exitNotice ?? enterNotice;
};
export function planProfileTransition(settingsService, targetId, deps = {}) {
    const options = resolveOptions(deps);
    // Resolve both sides before constructing the plan. In particular, do not
    // write activeProfileId before an unavailable required integration fails.
    const current = resolveActiveProfile(settingsService, options);
    const target = resolveProfile(targetId, options);
    const transitionClass = classifyProfileTransition(current, target);
    const exitNotice = transitionClass === 'noop' ? null : profileExitNotice(current);
    const enterNotice = transitionClass === 'noop' ? null : profileEnterNotice(target);
    return {
        targetId: target.identity.id,
        class: transitionClass,
        exitNotice,
        enterNotice,
        composedNotice: composeNotice(exitNotice, enterNotice),
    };
}
/** Owns Profile activation effects after pure resolution and classification. */
export class ProfileTransitionService {
    #settingsService;
    #deps;
    constructor(settingsServiceOrDeps, deps = {}) {
        if ('settingsService' in settingsServiceOrDeps) {
            this.#settingsService = settingsServiceOrDeps.settingsService;
            const { settingsService: _settingsService, ...transitionDeps } = settingsServiceOrDeps;
            this.#deps = transitionDeps;
        }
        else {
            this.#settingsService = settingsServiceOrDeps;
            this.#deps = deps;
        }
    }
    plan(targetId) {
        return planProfileTransition(this.#settingsService, targetId, this.#deps);
    }
    activate(targetId) {
        const plan = this.plan(targetId);
        if (plan.class === 'noop')
            return plan;
        this.commit(plan);
        return plan;
    }
    /**
     * Apply the runtime effects of a plan whose canonical selection has already
     * been committed by a surrounding settings transaction.
     */
    commit(plan) {
        if (plan.class === 'noop')
            return;
        if (plan.class === 'structural') {
            const confirmationRequired = typeof this.#deps.requiresHistoryConfirmation === 'function'
                ? this.#deps.requiresHistoryConfirmation()
                : this.#deps.requiresHistoryConfirmation ?? this.#deps.clearConversation !== undefined;
            if (confirmationRequired)
                this.#deps.clearConversation?.();
        }
        // SettingsService's canonical normalization updates the compatibility
        // flags and emits the active-profile change that rebuild subscribers use.
        // A caller using commit() has already performed that write atomically.
        if (this.#settingsService.get('app.activeProfileId') !== plan.targetId) {
            this.#settingsService.set('app.activeProfileId', plan.targetId);
        }
        if (plan.class === 'structural' || plan.class === 'agent-rebuild') {
            this.#deps.rebuildAgent?.();
        }
        if (plan.composedNotice)
            this.#deps.queueModeNotice?.(plan.composedNotice);
    }
}
//# sourceMappingURL=profile-transition.js.map