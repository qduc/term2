import type { ISettingsService } from '../../../../source/services/service-interfaces.js';
import type { SettingsService } from '../../../../source/services/settings/settings-service.js';
import type {
  RuntimeSettingMutation,
  RuntimeSettingsSnapshot,
} from '../../../../source/services/settings/session-runtime-settings.js';
import type { SettingKey, SettingValue, SettingsReader, SettingsScope, SettingsWriter } from '../../config/index.js';
import { createScopedSettings, type SettingsWriteMode } from '../../config/scoped-settings.js';

type LegacySettingsBinding = {
  readonly settings: SettingsWriter;
  readonly service: ISettingsService;
  readonly setRuntimeOverride: (mutation: RuntimeSettingMutation) => void;
};
export interface LegacySettingsSource {
  forSession(scope: SettingsScope, overrides?: ReadonlyMap<SettingKey, SettingValue>): SettingsWriter;
  forSessionBinding(
    scope: SettingsScope,
    overrides?: ReadonlyMap<SettingKey, SettingValue>,
    runtimeInitial?: RuntimeSettingsSnapshot,
  ): LegacySettingsBinding;
}
const pairedServices = new WeakMap<SettingsReader, ISettingsService>();
const bindingOrigins = new WeakMap<
  SettingsReader,
  {
    source: LegacySettingsSource;
    scope: SettingsScope;
    overrides: ReadonlyMap<SettingKey, SettingValue>;
  }
>();

/** Historical engine identity only; native config has no knowledge of source services. */
export function isLegacySettingsPair(settings: SettingsReader, service: ISettingsService): boolean {
  return pairedServices.get(settings) === service;
}

/** Rebind one historical session from its original scope, not another session's overlays. */
export function forkLegacySettingsBinding(
  settings: SettingsReader,
  service: ISettingsService,
  initial: RuntimeSettingsSnapshot,
): LegacySettingsBinding {
  const origin = bindingOrigins.get(settings);
  if (!origin || pairedServices.get(settings) !== service) throw new Error('Expected paired adopted settings');
  return origin.source.forSessionBinding(origin.scope, origin.overrides, initial);
}

/** Translates the source engine's settings protocol onto native scoped settings.
 * Runtime snapshot/mutation and paired-service identity remain historical concerns.
 */
export function createLegacySettingsSource(
  host: SettingsService,
  writeMode: SettingsWriteMode = 'persistent',
): LegacySettingsSource {
  const source: LegacySettingsSource = {
    forSession(scope, overrides) {
      return source.forSessionBinding(scope, overrides).settings;
    },
    forSessionBinding(scope, overrides = new Map(), runtimeInitial) {
      const values = new Map<SettingKey, SettingValue | undefined>(overrides);
      if (runtimeInitial) {
        values.set('agent.modelSelection' as SettingKey, runtimeInitial.selection);
        values.set('agent.reasoningEffort' as SettingKey, runtimeInitial.reasoningEffort);
        values.set('agent.temperature' as SettingKey, runtimeInitial.temperature);
      }
      const view = createScopedSettings(
        {
          read: (key) => host.getDynamic(key) as SettingValue | undefined,
          write(key, value, mode) {
            if (mode === 'runtime') {
              host.setDynamic(key, value, { persist: false });
              return;
            }
            const result = host.setPersistentDynamic(key, value);
            if (result.status !== 'saved') throw new Error(`Setting '${key}' was not persisted (${result.reason})`);
          },
          watch: (listener) => host.onChange(listener),
        },
        scope,
        values,
        writeMode,
      );
      const write = (key: string, value: SettingValue, options?: { persist?: boolean }) =>
        view.write(key as SettingKey, value, options?.persist === false ? 'runtime' : writeMode);
      const service = {
        get: view.readPath,
        getDynamic: view.readPath,
        getSource: (key: string) => {
          const origin = view.origin(key);
          return origin === 'hidden' ? 'default' : origin === 'override' ? 'cli' : host.getSource(key as never);
        },
        set: write,
        setDynamic: write,
        setPersistent: (key: string, value: SettingValue) => view.write(key as SettingKey, value, 'persistent'),
        setPersistentDynamic: (key: string, value: SettingValue) => view.write(key as SettingKey, value, 'persistent'),
        onChange: (listener: (key?: string) => void) =>
          view.observe((keys) => listener(keys.length === 1 ? keys[0] : undefined)),
      } as ISettingsService;
      pairedServices.set(view.settings, service);
      bindingOrigins.set(view.settings, {
        source,
        scope: { readable: [...scope.readable], writable: [...scope.writable] },
        overrides: new Map([...overrides].map(([key, value]) => [key, structuredClone(value)])),
      });
      return {
        settings: view.settings,
        service,
        setRuntimeOverride(mutation) {
          if (!runtimeInitial) throw new Error('Not a runtime-owned settings binding');
          const [key, value] =
            mutation.kind === 'model'
              ? ['agent.modelSelection', mutation.selection]
              : mutation.kind === 'reasoning'
              ? ['agent.reasoningEffort', mutation.effort]
              : ['agent.temperature', mutation.temperature];
          view.replaceOverride(key as SettingKey, value as SettingValue | undefined);
          // The source client setter owns the only refresh for this change.
        },
      };
    },
  };
  return source;
}
