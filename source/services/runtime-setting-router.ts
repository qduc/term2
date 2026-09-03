import type { SettingsService } from './settings/settings-service.js';
import type { ReasoningEffortSetting } from '../contracts/conversation.js';
import { setTrimConfig } from '../utils/output/output-trim.js';
import { ProfileTransitionService, type ProfileTransitionPlan } from './profiles/profile-transition.js';
import { profileIdFromLegacyModeSetting } from './profiles/legacy-adapter.js';
import { isLegacyModeSettingKey } from './profiles/legacy-adapter.js';
import { buildToggleConflictNotice, isToolToggleKey } from './tool-toggles.js';

export interface RuntimeSettingRouterConversationService {
  switchProvider(provider: string): void;
  queueModeNotice(text: string): void;
}

export interface RuntimeSettingRouterDeps {
  conversationService: RuntimeSettingRouterConversationService;
  settingsService: SettingsService;
  setModel: (model: string) => void;
  setReasoningEffort: (effort: ReasoningEffortSetting) => void;
  setTemperature: (temp: number | undefined) => void;
}

export type ConversationSettingChange = Readonly<{
  key: string;
  value: unknown;
  persistence: 'runtime' | 'restart';
}>;

/**
 * Owns the application effects of conversation-related settings. Menu code
 * only translates input into changes; this service applies the effective
 * settings transaction and then updates the live conversation/runtime.
 */
export class ConversationConfigurationService {
  readonly #deps: RuntimeSettingRouterDeps;

  constructor(deps: RuntimeSettingRouterDeps) {
    this.#deps = deps;
  }

  apply(changes: readonly ConversationSettingChange[]): { restartOnly: readonly string[] } {
    const runtime = changes.filter((change) => change.persistence === 'runtime');
    if (runtime.length > 0) {
      let currentProfileId = String(this.#deps.settingsService.get('app.activeProfileId'));
      const canonicalRuntime = runtime.map((change) => {
        if (!isLegacyModeSettingKey(change.key)) {
          if (change.key === 'app.activeProfileId' && typeof change.value === 'string') {
            currentProfileId = change.value;
          }
          return change;
        }
        const profileId = profileIdFromLegacyModeSetting(change.key, change.value, currentProfileId);
        if (!profileId) return change;
        currentProfileId = profileId;
        return { ...change, key: 'app.activeProfileId', value: profileId };
      });
      const activeProfileChange = [...canonicalRuntime]
        .reverse()
        .find((change) => change.key === 'app.activeProfileId');
      const profileTransition = activeProfileChange
        ? new ProfileTransitionService({
            settingsService: this.#deps.settingsService,
            rebuildAgent: () => this.#deps.setModel(this.#deps.settingsService.get('agent.model')),
            queueModeNotice: (text) => this.#deps.conversationService.queueModeNotice(text),
          })
        : undefined;
      // Profile planning must happen before the transaction changes the active
      // identity. The transaction owns canonical settings publication; the
      // prepared plan owns the corresponding runtime effects afterward.
      const profilePlan = profileTransition?.plan(String(activeProfileChange?.value)) as
        | ProfileTransitionPlan
        | undefined;
      // Previous toggle values must be read before the transaction publishes
      // the new ones, so only true→false flips count as newly disabled.
      const previousToggleValues = new Map(
        canonicalRuntime
          .filter((change) => isToolToggleKey(change.key))
          .map((change) => [change.key, this.#deps.settingsService.getDynamic(change.key)]),
      );
      this.#deps.settingsService.setDynamicTransaction(canonicalRuntime.map(({ key, value }) => ({ key, value })));
      for (const change of canonicalRuntime) {
        if (change.key !== 'app.activeProfileId') this.applyRuntimeSetting(change.key, change.value);
      }
      if (profileTransition && profilePlan) profileTransition.commit(profilePlan);
      this.#queueToolToggleConflictNotice(canonicalRuntime, previousToggleValues);
    }
    for (const change of changes.filter((item) => item.persistence === 'restart')) {
      this.#deps.settingsService.setPersistentDynamic(change.key, change.value);
    }
    return { restartOnly: changes.filter((change) => change.persistence === 'restart').map((change) => change.key) };
  }

  reset(key: string): void {
    this.#deps.settingsService.reset(key);
    if (this.#deps.settingsService.isRuntimeModifiable(key)) {
      this.applyRuntimeSetting(key, this.#deps.settingsService.getDynamic(key));
    }
  }

  /**
   * Warns once per batch when a newly disabled toggle conflicts with the
   * now-active profile's guidance (tool-toggles.ts). Profiles keep declaring
   * their tools regardless of toggles, so without this the model only finds
   * out mid-run that a referenced tool does not exist.
   */
  #queueToolToggleConflictNotice(
    canonicalRuntime: readonly ConversationSettingChange[],
    previousToggleValues: ReadonlyMap<string, unknown>,
  ): void {
    const newlyDisabled = canonicalRuntime
      .filter((change) => isToolToggleKey(change.key))
      .filter((change) => change.value === false && previousToggleValues.get(change.key) !== false)
      .map((change) => change.key);
    const notice = buildToggleConflictNotice(this.#deps.settingsService, newlyDisabled);
    if (notice) {
      this.#deps.conversationService.queueModeNotice(notice);
    }
  }

  applyRuntimeSetting(key: string, value: unknown): void {
    applyRuntimeSettingChange(key, value, this.#deps);
  }
}

export function applyRuntimeSettingChange(key: string, value: unknown, deps: RuntimeSettingRouterDeps): void {
  if (key === 'app.activeProfileId') {
    const transitionService = new ProfileTransitionService({
      settingsService: deps.settingsService,
      rebuildAgent: () => deps.setModel(deps.settingsService.get('agent.model')),
      queueModeNotice: (text) => deps.conversationService.queueModeNotice(text),
    });
    transitionService.activate(String(value));
    return;
  }

  if (key === 'agent.model') {
    deps.setModel(String(value));
    return;
  }

  if (isToolToggleKey(key)) {
    // A capability toggle changes which tools the next request may use, so the
    // agent rebuilds exactly like a model change. The settings transaction has
    // already been applied by the caller.
    deps.setModel(deps.settingsService.get('agent.model'));
    return;
  }

  if (key === 'agent.reasoningEffort') {
    deps.setReasoningEffort(value as ReasoningEffortSetting);
    return;
  }

  if (key === 'agent.temperature') {
    if (value == null) {
      deps.setTemperature(undefined);
      return;
    }

    const numeric = typeof value === 'number' ? value : Number(value);
    deps.setTemperature(Number.isFinite(numeric) ? numeric : undefined);
    return;
  }

  if (key === 'agent.provider') {
    deps.conversationService.switchProvider(String(value));
    return;
  }

  if (key === 'agent.transport') {
    deps.setModel(deps.settingsService.get('agent.model'));
    return;
  }

  if (
    key === 'agent.smartModel' ||
    key === 'agent.smartProvider' ||
    key === 'agent.balancedModel' ||
    key === 'agent.balancedProvider' ||
    key === 'agent.cheapModel' ||
    key === 'agent.cheapProvider' ||
    key === 'agent.choreModel' ||
    key === 'agent.choreProvider' ||
    key === 'agent.mentorModel' ||
    key === 'agent.mentorProvider' ||
    key === 'agent.mentorReasoningEffort'
  ) {
    deps.setModel(deps.settingsService.get('agent.model'));
    return;
  }

  if (key === 'shell.autoApproveMode') {
    return;
  }

  if (key === 'shell.maxOutputLines') {
    setTrimConfig({ maxLines: Number(value) });
    return;
  }

  if (key === 'shell.maxOutputChars') {
    setTrimConfig({ maxCharacters: Number(value) });
  }
}
