import type { ISettingsService } from '../shared/service-interfaces.js';
import { isBareProfile } from '../session/prompts/prompt-constructor.js';
import { resolveActiveProfile } from '../config/profiles/active-profile.js';
import { BUILTIN_INTEGRATIONS } from '../config/profiles/registry.js';
import { resolveProfile } from '../config/profiles/resolver.js';
import type { ResolvedProfile } from '../config/profiles/types.js';

export type ProfileTransitionClass = 'noop' | 'structural' | 'agent-rebuild';

export type ProfileTransitionPlan = {
  targetId: string;
  class: ProfileTransitionClass;
};

export type ProfileTransitionPlanningDeps = {
  availableIntegrations?: ReadonlyMap<string, boolean>;
};

export type ProfileTransitionDeps = ProfileTransitionPlanningDeps & {
  /** Rebuild the active agent using the currently selected model. */
  rebuildAgent?: () => void;
  /** Whether this structural transition has existing history to protect. */
  requiresHistoryConfirmation?: boolean | (() => boolean);
  /** Clear the conversation when a structural transition is confirmed. */
  clearConversation?: () => void | Promise<void>;
};

/** The interactive runtime exposes all built-in integration points. */
const DEFAULT_AVAILABLE_INTEGRATIONS: ReadonlyMap<string, boolean> = new Map(
  BUILTIN_INTEGRATIONS.map((id) => [id, true]),
);

const resolveOptions = (deps: ProfileTransitionPlanningDeps) => ({
  availableIntegrations: deps.availableIntegrations ?? DEFAULT_AVAILABLE_INTEGRATIONS,
});

/**
 * Classify the runtime impact of changing between two resolved Profiles.
 * Identity equality intentionally wins: re-selecting a Profile has no effects.
 */
export function classifyProfileTransition(current: ResolvedProfile, target: ResolvedProfile): ProfileTransitionClass {
  if (current.identity.id === target.identity.id) return 'noop';

  if (isBareProfile(current) !== isBareProfile(target)) return 'structural';

  // A non-built-in Profile cannot be assumed to have a stable prompt/tool
  // shape. Rebuild it conservatively rather than allowing stale composition.
  return 'agent-rebuild';
}

function planProfileTransition(
  settingsService: ISettingsService,
  targetId: string,
  deps: ProfileTransitionPlanningDeps = {},
): ProfileTransitionPlan {
  const options = resolveOptions(deps);
  // Resolve both sides before constructing the plan. In particular, do not
  // write activeProfileId before an unavailable required integration fails.
  const current = resolveActiveProfile(settingsService, options);
  const target = resolveProfile(targetId, options);
  return { targetId: target.identity.id, class: classifyProfileTransition(current, target) };
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

    this.commit(plan);
    return plan;
  }

  /**
   * Apply the runtime effects of a plan whose canonical selection has already
   * been committed by a surrounding settings transaction.
   */
  commit(plan: ProfileTransitionPlan): void {
    if (plan.class === 'noop') return;

    if (plan.class === 'structural') {
      const confirmationRequired =
        typeof this.#deps.requiresHistoryConfirmation === 'function'
          ? this.#deps.requiresHistoryConfirmation()
          : this.#deps.requiresHistoryConfirmation ?? this.#deps.clearConversation !== undefined;
      if (confirmationRequired) this.#deps.clearConversation?.();
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
  }
}
