/** Isolated, source-schema-validated settings for one prepared runtime generation. */
import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { isDroppedProfile } from './dropped-profiles.js';
import { getProfileMetadata } from '../config/profiles/active-profile.js';
import { canonicalProfileId, legacyModeFromProfileId } from '../config/profiles/legacy-adapter.js';
import {
  SettingsSchema,
  AgentSettingsSchema,
  type SettingKey,
  type SettingValue,
} from '../config/settings/settings-schema.js';
import { ModelSelectionSchema } from '../config/settings/model-selection.js';
import { getProvider } from '../model/providers/index.js';
import type { ISettingsService } from '../shared/service-interfaces.js';
import type { DirectCommandConfiguration } from '../session/command-types.js';

/** App preparation accepts selection intent. Native/protocol ingress must retain
 * both fields; effective accepted configuration remains source-resolved values. */
export type DirectApprovalMode = Extract<SettingValue<'shell.autoApproveMode'>, 'off' | 'auto' | 'always'>;

export type DirectAppConfiguration = Omit<DirectCommandConfiguration, 'reasoning'> & {
  readonly reasoning?: SettingValue<'agent.reasoningEffort'>;
  readonly profileId?: string;
  /** App-only launch intent. Never accepted from a native wire configuration. */
  readonly approvalMode?: DirectApprovalMode;
};

const sessionUpdate = z
  .object({
    clientRequestId: z.string().min(1),
    expectedRevision: z.string().min(1),
    admission: z.literal('idle').optional(),
    modelSelection: ModelSelectionSchema.strict().optional(),
    reasoningEffort: AgentSettingsSchema.out.shape.reasoningEffort.optional(),
    mode: z.enum(['standard', 'bare', 'lite']).optional(),
  })
  .strict();

/** A pure HTTP-to-native intent translation. Preserve the caller's invocation key
 * and native revision on retries; do not read current revision, guess defaults,
 * mutate settings, or resolve a model's effective reasoning before acceptance.
 * Unknown fields and empty mutation bodies are rejected, never partially applied. */
export function prepareDirectSessionConfigurationCommand(body: unknown) {
  const value = sessionUpdate.parse(body);
  if (value.modelSelection === undefined && value.reasoningEffort === undefined && value.mode === undefined) {
    throw new Error('Session configuration mutation requires at least one selection field.');
  }
  const configuration: DirectAppConfiguration = {
    ...(value.modelSelection !== undefined ? { model: value.modelSelection } : {}),
    ...(value.reasoningEffort !== undefined ? { reasoning: value.reasoningEffort } : {}),
    ...(value.mode !== undefined ? { profileId: canonicalProfileId(`builtin:${value.mode}`) } : {}),
  };
  return {
    type: 'configure' as const,
    commandId: value.clientRequestId,
    admission: 'idle' as const,
    expectedRevision: value.expectedRevision,
    configuration,
  };
}

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
  patch: DirectAppConfiguration,
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
    // Asking for such a model is refused here. A session whose own provider is gone (deleted from settings) still
    // opens, as legacy resumes it: its next turn fails when the model is resolved, with this same message.
    if (patch.model !== undefined)
      throw new Error(`Provider '${requested.provider}' does not expose an application streamed model.`);
  }
  // The source registry owns provider aliases; catalogs do not restrict custom model IDs.
  agent.modelSelection = { provider: provider?.id ?? requested.provider, model: requested.model };
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
  if (patch.profileId !== undefined) {
    // Resolve before changing the private snapshot; invalid profiles fail the
    // complete preparation. Source owns aliases and legacy compatibility flags.
    if (isDroppedProfile(patch.profileId)) throw new Error(`Missing parent or Profile '${patch.profileId}'`);
    const profileId = getProfileMetadata(patch.profileId).activeProfileId;
    const app = snapshot.app as Record<string, unknown>;
    app.activeProfileId = profileId;
    sources.set('app.activeProfileId', 'cli');
    try {
      const legacy = legacyModeFromProfileId(profileId);
      Object.assign(app, legacy);
      for (const key of Object.keys(legacy)) sources.set(`app.${key}`, 'cli');
    } catch {
      // SettingsService likewise leaves custom-profile compatibility flags alone.
    }
  }
  if (patch.approvalMode !== undefined) {
    (snapshot.shell as Record<string, unknown>).autoApproveMode = patch.approvalMode;
    (snapshot.sandbox as Record<string, unknown>).enabled = patch.approvalMode !== 'always';
    sources.set('shell.autoApproveMode', 'cli');
    sources.set('sandbox.enabled', 'cli');
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

/** Carry accepted settings into later tool generations. Approval policy is live only. */
export function recordDirectConfigSettings(
  settings: ISettingsService,
  intent: DirectConfigurationIntent,
  profileId: string,
  options: { readonly persist: boolean; readonly approvalMode?: DirectApprovalMode },
): void {
  const record = (key: string, value: unknown) =>
    settings.setDynamic(
      key,
      value,
      options.persist && !isDeepStrictEqual(settings.getDynamic(key), value) ? {} : { persist: false },
    );
  record('app.activeProfileId', profileId);
  if (options.approvalMode !== undefined) {
    settings.set('shell.autoApproveMode', options.approvalMode, { persist: false });
    settings.set('sandbox.enabled', options.approvalMode !== 'always', { persist: false });
  }
  record('agent.modelSelection', intent.modelSelection);
  record('agent.reasoningEffort', intent.reasoningEffort);
  if (intent.temperature !== undefined) record('agent.temperature', intent.temperature);
}
