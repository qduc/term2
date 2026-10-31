/** Isolated, source-schema-validated settings for one prepared runtime generation. */
import {
  SettingsSchema,
  type SettingKey,
  type SettingValue,
} from '../../../source/services/settings/settings-schema.js';
import { ModelSelectionSchema } from '../../../source/services/settings/model-selection.js';
import { getProvider } from '../../../source/providers/index.js';
import type { ISettingsService } from '../../../source/services/service-interfaces.js';
import type { DirectCommandConfiguration } from '../session/direct-command-types.js';

export type DirectConfigurationIntent = {
  readonly modelSelection: ReturnType<typeof ModelSelectionSchema.parse>;
  readonly reasoningEffort: 'default' | NonNullable<DirectCommandConfiguration['reasoning']>;
  readonly temperature?: number;
};

/**
 * Snapshot every settings section, including credentials and policy, without a
 * SettingsService constructor (which would reread disk). Preserve provenance:
 * default output allocation is not interchangeable with an explicit token cap.
 * This generation is read-only; selection writes must go through Session's
 * persisted configure boundary, never through a tool or an application default.
 */
export function createDirectConfigSettings(
  current: ISettingsService,
  patch: DirectCommandConfiguration,
): { readonly settings: ISettingsService; readonly intent: DirectConfigurationIntent } {
  const snapshot = Object.fromEntries(
    Object.keys(SettingsSchema.shape).map((root) => [root, structuredClone(current.getDynamic(root))]),
  );
  const sources = new Map<string, ReturnType<NonNullable<ISettingsService['getSource']>>>();
  const rememberSources = (value: unknown, path: string): void => {
    sources.set(path, current.getSource?.(path) ?? 'cli');
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [key, child] of Object.entries(value)) rememberSources(child, path ? `${path}.${key}` : key);
    }
  };
  for (const [root, value] of Object.entries(snapshot)) rememberSources(value, root);

  const agent = snapshot.agent as Record<string, unknown> | undefined;
  if (!agent) throw new Error('Current Session has no effective agent settings.');
  const requested = ModelSelectionSchema.parse(patch.model ?? agent.modelSelection);
  const provider = getProvider(requested.provider);
  if (!provider?.createStreamedModel) {
    throw new Error(`Provider '${requested.provider}' does not expose an application streamed model.`);
  }
  // The source registry owns provider aliases; catalogs do not restrict custom model IDs.
  agent.modelSelection = { provider: provider.id, model: requested.model };
  if (patch.model !== undefined) {
    sources.set('agent.modelSelection', 'cli');
    sources.set('agent.modelSelection.provider', 'cli');
    sources.set('agent.modelSelection.model', 'cli');
  }
  if (patch.reasoning !== undefined) {
    agent.reasoningEffort = patch.reasoning;
    sources.set('agent.reasoningEffort', 'cli');
  }
  if (patch.temperature !== undefined) {
    agent.temperature = patch.temperature;
    sources.set('agent.temperature', 'cli');
  }
  const data = SettingsSchema.parse(snapshot);
  const read = (key: string): unknown => {
    const value = key.split('.').reduce<unknown>((parent, part) => {
      if (!parent || typeof parent !== 'object' || !Object.hasOwn(parent, part)) return undefined;
      return (parent as Record<string, unknown>)[part];
    }, data);
    return structuredClone(value);
  };
  const refuseWrite = (): never => {
    throw new Error('Runtime generation settings are read-only; use Session.configure.');
  };
  const settings: ISettingsService = {
    get: <K extends SettingKey>(key: K): SettingValue<K> => read(key) as SettingValue<K>,
    getDynamic: read,
    getSource: (key) => sources.get(key) ?? 'default',
    set: refuseWrite,
    setDynamic: refuseWrite,
    setPersistent: refuseWrite,
    setPersistentDynamic: refuseWrite,
    // No live source subscription: this generation never follows another Session's changes.
    onChange: () => () => {},
  };
  return {
    settings,
    intent: {
      modelSelection: settings.get('agent.modelSelection'),
      reasoningEffort: settings.get('agent.reasoningEffort'),
      ...(settings.get('agent.temperature') !== undefined ? { temperature: settings.get('agent.temperature') } : {}),
    },
  };
}
