import type { ISettingsService } from '../service-interfaces.js';
import { isLiteProfile } from '../../prompts/prompt-constructor.js';
import { profileEnterNotice, profileExitNotice } from '../mode-notices.js';
import { resolveActiveProfile } from './active-profile.js';
import { BUILTIN_INTEGRATIONS } from './registry.js';
import { resolveProfile } from './resolver.js';
import type { ResolvedProfile } from './types.js';

export type ProfileTransitionClass = 'noop' | 'structural' | 'notice-only' | 'agent-rebuild';

export type ProfileTransitionPlan = {
  targetId: string;
  class: ProfileTransitionClass;
  exitNotice: string | null;
  enterNotice: string | null;
  composedNotice: string | null;
};

export type ProfileTransitionPlanningDeps = {
  availableIntegrations?: ReadonlyMap<string, boolean>;
};

export type ProfileTransitionDeps = ProfileTransitionPlanningDeps & {
  /** Rebuild the active agent using the currently selected model. */
  rebuildAgent?: () => void;
  /** Queue the one notice produced by this transition. */
  queueModeNotice?: (text: string) => void;
  /** Whether this structural transition has existing history to protect. */
  requiresHistoryConfirmation?: boolean | (() => boolean);
  /** Clear the conversation when a structural transition is confirmed. */
  clearConversation?: () => void | Promise<void>;
};

/** The interactive runtime exposes all built-in integration points. */
export const DEFAULT_AVAILABLE_INTEGRATIONS: ReadonlyMap<string, boolean> = new Map(
  BUILTIN_INTEGRATIONS.map((id) => [id, true]),
);

const resolveOptions = (deps: ProfileTransitionPlanningDeps) => ({
  availableIntegrations: deps.availableIntegrations ?? DEFAULT_AVAILABLE_INTEGRATIONS,
});

const isProfile = (profile: ResolvedProfile, id: string): boolean => profile.identity.id === id;

/**
 * Classify the runtime impact of changing between two resolved Profiles.
 * Identity equality intentionally wins: re-selecting a Profile has no effects,
 * even when that Profile itself carries a workflow notice.
 */
export function classifyProfileTransition(current: ResolvedProfile, target: ResolvedProfile): ProfileTransitionClass {
  if (current.identity.id === target.identity.id) return 'noop';

  if (isLiteProfile(current) !== isLiteProfile(target)) return 'structural';

  const agentWorkflowInvolved =
    isProfile(current, 'builtin:mentor') ||
    isProfile(target, 'builtin:mentor') ||
    isProfile(current, 'builtin:orchestrator') ||
    isProfile(target, 'builtin:orchestrator');
  if (agentWorkflowInvolved) return 'agent-rebuild';

  const planInvolved = isProfile(current, 'builtin:plan') || isProfile(target, 'builtin:plan');
  if (planInvolved) return 'notice-only';

  // A non-built-in Profile cannot be assumed to have a stable prompt/tool
  // shape. Rebuild it conservatively rather than allowing stale composition.
  return 'agent-rebuild';
}

const composeNotice = (exitNotice: string | null, enterNotice: string | null): string | null => {
  if (exitNotice && enterNotice) return `${exitNotice}\n\n${enterNotice}`;
  return exitNotice ?? enterNotice;
};

export function planProfileTransition(
  settingsService: ISettingsService,
  targetId: string,
  deps: ProfileTransitionPlanningDeps = {},
): ProfileTransitionPlan {
  const options = resolveOptions(deps);
  // Resolve both sides before constructing the plan. In particular, do not
  // write activeProfileId before an unavailable required integration fails.
  const current = resolveActiveProfile(settingsService, options);
  const target = resolveProfile(targetId, options);
  const transitionClass = classifyProfileTransition(current, target);
  const exitNotice = transitionClass === 'noop' ? null : profileExitNotice(current.identity.id);
  const enterNotice = transitionClass === 'noop' ? null : profileEnterNotice(target.identity.id);

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
  readonly #settingsService: ISettingsService;
  readonly #deps: ProfileTransitionDeps;

  constructor(settingsService: ISettingsService, deps?: ProfileTransitionDeps);
  constructor(deps: ProfileTransitionDeps & { settingsService: ISettingsService });
  constructor(
    settingsServiceOrDeps: ISettingsService | (ProfileTransitionDeps & { settingsService: ISettingsService }),
    deps: ProfileTransitionDeps = {},
  ) {
    if ('settingsService' in settingsServiceOrDeps) {
      this.#settingsService = settingsServiceOrDeps.settingsService;
      const { settingsService: _settingsService, ...transitionDeps } = settingsServiceOrDeps;
      this.#deps = transitionDeps;
    } else {
      this.#settingsService = settingsServiceOrDeps;
      this.#deps = deps;
    }
  }

  plan(targetId: string): ProfileTransitionPlan {
    return planProfileTransition(this.#settingsService, targetId, this.#deps);
  }

  activate(targetId: string): ProfileTransitionPlan {
    const plan = this.plan(targetId);
    if (plan.class === 'noop') return plan;

    if (plan.class === 'structural') {
      const confirmationRequired =
        typeof this.#deps.requiresHistoryConfirmation === 'function'
          ? this.#deps.requiresHistoryConfirmation()
          : this.#deps.requiresHistoryConfirmation ?? this.#deps.clearConversation !== undefined;
      if (confirmationRequired) this.#deps.clearConversation?.();
    }

    // SettingsService's canonical normalization updates the compatibility
    // flags and emits the active-profile change that rebuild subscribers use.
    this.#settingsService.set('app.activeProfileId', plan.targetId);

    if (plan.class === 'structural' || plan.class === 'agent-rebuild') {
      this.#deps.rebuildAgent?.();
    }
    if (plan.composedNotice) this.#deps.queueModeNotice?.(plan.composedNotice);
    return plan;
  }
}
