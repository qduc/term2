/**
 * The app's one settings owner, and the policy that seeds one session's copy of it.
 * `SessionSettingsService` never reads or writes the file itself. `createSessionSettings`
 * fills that copy from the launch selection without letting one session's restored
 * model or profile rewrite another's. `inheritSessionSettings` carries a session's
 * copy into a successor created during that call.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { isDeepStrictEqual } from 'node:util';
import { BARE_PROFILE_ID } from '../config/profiles/legacy-adapter.js';
import { isDroppedProfile } from './dropped-profiles.js';
import { RUNTIME_MODIFIABLE_SETTINGS } from '../config/settings/settings-schema.js';
import { buildEnvOverrides } from '../config/settings/settings-env.js';
import type { DirectRuntimeContext } from '../session/store.js';
import type { ProfileSelection } from './tool-contract.js';
import { SettingsService } from './settings-service.js';

export type AppSettingsOptions = NonNullable<ConstructorParameters<typeof SettingsService>[0]>;
export type { SettingsService };
type DurableWriteResult = ReturnType<SettingsService['setDynamic']>;

export function createSettingsService(options: AppSettingsOptions = {}): SettingsService {
  return new SettingsService(options);
}

/**
 * A session's own settings. It never reads or writes the file itself, so a session keeps its start facts and
 * unsaved changes to itself. Once `saveThrough` names the app's settings owner, every write that legacy's one
 * service would save (a `setDynamic` without `persist: false`, `setPersistentDynamic`, `reset` and the
 * transactions built on them) is also applied to the owner, which saves `settings.json` as legacy does.
 */
/** Throws for a value a session must never take, as one host serving several modes decides per session. */
export type SettingRefusal = (key: (typeof REFUSABLE_KEYS)[number], value: unknown) => void;
const REFUSABLE_KEYS = ['shell.autoApproveMode', 'sandbox.enabled'] as const;

class SessionSettingsService extends SettingsService {
  // Not a #private field: the base constructor may call the overrides before this class initialises its fields.
  private owner: SettingsService | undefined;
  private refuse: SettingRefusal | undefined;

  constructor(options: AppSettingsOptions) {
    super({ ...options, disableFilePersistence: true });
  }

  /** Attach after the session's start facts are set: those are never saved. */
  saveThrough(owner: SettingsService): void {
    this.owner = owner;
  }

  /** From now on every write, whichever path it takes, is checked first. */
  refuseValues(refuse: SettingRefusal): void {
    this.refuse = refuse;
  }

  /** Checks each refused key a write to `key` would change, nested values included. */
  private check(key: string, value: unknown): void {
    if (!this.refuse) return;
    for (const guarded of REFUSABLE_KEYS) {
      if (guarded === key) this.refuse(guarded, value);
      else if (guarded.startsWith(`${key}.`)) {
        let nested: unknown = value;
        for (const part of guarded.slice(key.length + 1).split('.'))
          nested = nested && typeof nested === 'object' ? (nested as Record<string, unknown>)[part] : undefined;
        if (nested !== undefined) this.refuse(guarded, nested);
      }
    }
  }

  override setDynamic(key: string, value: unknown, options?: { persist?: boolean }): DurableWriteResult {
    this.check(key, value);
    const result = super.setDynamic(key, value, { persist: false });
    if (options?.persist === false || !this.owner) return result;
    return this.owner.setDynamic(key, this.getDynamic(key));
  }

  override setPersistentDynamic(key: string, value: unknown): DurableWriteResult {
    this.check(key, value);
    const result = super.setPersistentDynamic(key, value);
    return this.owner ? this.owner.setPersistentDynamic(key, this.getDynamic(key)) : result;
  }

  override setPersistentDynamicTransaction(changes: readonly { key: string; value: unknown }[]): DurableWriteResult {
    for (const { key, value } of changes) this.check(key, value);
    if (!this.owner) return super.setPersistentDynamicTransaction(changes);
    const result = this.owner.setPersistentDynamicTransaction(changes);
    // The owner applies the batch only once it is saved; so does this copy.
    if (result.status === 'saved') for (const { key, value } of changes) super.setPersistentDynamic(key, value);
    return result;
  }

  override reset(key?: string): DurableWriteResult {
    for (const guarded of REFUSABLE_KEYS)
      if (!key || guarded === key || guarded.startsWith(`${key}.`)) this.check(guarded, this.getDefault(guarded));
    const result = super.reset(key);
    return this.owner ? this.owner.reset(key) : result;
  }
}

/** The settings a new session continues from, carried through the store's creation call. */
const continuedSettings = new AsyncLocalStorage<SettingsService>();

/** Targets of src/config/settings/ancillary-settings-migration.ts. */
const ANCILLARY_MIGRATION_TARGETS = [
  'agent.smartReasoningEffort',
  'agent.balancedReasoningEffort',
  'agent.cheapReasoningEffort',
  'agent.decisionModel',
] as const;

/**
 * Legacy's one service migrates an old key (say `agent.mentorReasoningEffort`) only when it loads the file at
 * launch, and the file it writes keeps the old key without the new one. A session reading that file again would
 * migrate a key the launch did not have and show a value legacy shows only from its next launch on.
 */
function keepLoadTimeMigrations(settings: SettingsService, launch: Pick<SettingsService, 'getDynamic'>): void {
  for (const key of ANCILLARY_MIGRATION_TARGETS) {
    const value = launch.getDynamic(key);
    if (isDeepStrictEqual(value, settings.getDynamic(key))) continue;
    if (value === undefined) settings.reset(key);
    else if (settings.isRuntimeModifiable(key)) settings.setDynamic(key, value, { persist: false });
  }
}

type SessionSettingsLaunch = {
  readonly selection: ProfileSelection;
  readonly profileExplicit?: boolean;
  readonly approvalAlwaysAsks?: boolean;
  readonly requireSandbox?: boolean;
  readonly refuseSetting?: SettingRefusal;
};

/**
 * A session owns its settings. `selection.settings` only supplies defaults: one
 * host runs sessions with different models and profiles, and restoring one
 * session's saved selection must not change another session's.
 */
export function createSessionSettings(
  { selection, profileExplicit, approvalAlwaysAsks, requireSandbox, refuseSetting }: SessionSettingsLaunch,
  { metadata, configuration, model }: DirectRuntimeContext,
): SettingsService {
  const continued = continuedSettings.getStore();
  const defaults = continued ?? selection.settings;
  const settingsDir = selection.settings instanceof SettingsService ? selection.settings.settingsDir : undefined;
  const settings = new SessionSettingsService({
    ...(settingsDir ? { settingsDir } : {}),
    env: buildEnvOverrides(),
    loggingService: selection.logger,
  });
  // `/clear` must not undo what someone changed, least of all a tightened approval
  // mode. Only real differences: rewriting a default would change what it means.
  if (continued) {
    for (const key of RUNTIME_MODIFIABLE_SETTINGS) {
      const value = continued.getDynamic(key);
      if (value !== undefined && !isDeepStrictEqual(value, settings.getDynamic(key))) {
        settings.setDynamic(key, value, { persist: false });
      }
    }
  }
  keepLoadTimeMigrations(settings, defaults);
  // Launch-only policy flags keep their CLI precedence when each session reads its own settings.
  for (const key of ['shell.autoApproveMode', 'shell.showReview'] as const) {
    if (defaults.getSource?.(key) === 'cli') settings.setDynamic(key, defaults.get(key), { persist: false });
  }
  // The latest configuration, where there is one, outranks the session's start fact.
  const stored = configuration?.profile ?? metadata?.profile;
  // A saved dropped workflow is historical data, not authority to reactivate it (#149).
  const profile = stored && !profileExplicit ? stored.id : defaults.get('app.activeProfileId');
  settings.set('app.activeProfileId', isDroppedProfile(profile) ? BARE_PROFILE_ID : profile, { persist: false });
  settings.set('agent.modelSelection', model, { persist: false });
  const reasoning =
    configuration?.intent.reasoningEffort ??
    (metadata ? metadata.reasoning ?? 'default' : defaults.get('agent.reasoningEffort'));
  settings.set('agent.reasoningEffort', reasoning, { persist: false });
  const temperature = configuration?.intent.temperature;
  if (temperature !== undefined) settings.set('agent.temperature', temperature, { persist: false });
  if (approvalAlwaysAsks) settings.set('shell.autoApproveMode', 'off', { persist: false });
  if (requireSandbox) settings.set('sandbox.enabled', true, { persist: false });
  // From here on, what legacy's one service would save is saved through the app's settings owner.
  if (selection.settings instanceof SettingsService) settings.saveThrough(selection.settings);
  if (refuseSetting) settings.refuseValues(refuseSetting);
  return settings;
}

/** A session created during `operation` starts from `source`, not the launch defaults. */
export function inheritSessionSettings<Result>(
  source: SettingsService | undefined,
  operation: () => Promise<Result>,
): Promise<Result> {
  return source ? continuedSettings.run(source, operation) : operation();
}
