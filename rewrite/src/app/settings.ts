/** The app's one settings owner: the source `SettingsService`. Sessions build their own runtime generations from it. */
import { SettingsService } from '../../../source/services/settings/settings-service.js';

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
export class SessionSettingsService extends SettingsService {
  // Not a #private field: the base constructor may call the overrides before this class initialises its fields.
  private owner: SettingsService | undefined;

  constructor(options: AppSettingsOptions) {
    super({ ...options, disableFilePersistence: true });
  }

  /** Attach after the session's start facts are set: those are never saved. */
  saveThrough(owner: SettingsService): void {
    this.owner = owner;
  }

  override setDynamic(key: string, value: unknown, options?: { persist?: boolean }): DurableWriteResult {
    const result = super.setDynamic(key, value, { persist: false });
    if (options?.persist === false || !this.owner) return result;
    return this.owner.setDynamic(key, this.getDynamic(key));
  }

  override setPersistentDynamic(key: string, value: unknown): DurableWriteResult {
    const result = super.setPersistentDynamic(key, value);
    return this.owner ? this.owner.setPersistentDynamic(key, this.getDynamic(key)) : result;
  }

  override setPersistentDynamicTransaction(changes: readonly { key: string; value: unknown }[]): DurableWriteResult {
    if (!this.owner) return super.setPersistentDynamicTransaction(changes);
    const result = this.owner.setPersistentDynamicTransaction(changes);
    // The owner applies the batch only once it is saved; so does this copy.
    if (result.status === 'saved') for (const { key, value } of changes) super.setPersistentDynamic(key, value);
    return result;
  }

  override reset(key?: string): DurableWriteResult {
    const result = super.reset(key);
    return this.owner ? this.owner.reset(key) : result;
  }
}
