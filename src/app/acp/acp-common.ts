/**
 * `term2 acp` policy shared by the in-process launcher, the daemon client and the
 * daemon itself, so ACP sessions keep one posture whichever process hosts them.
 */
import { getAllProviders, getProviderIds } from '../../model/providers/index.js';
import { resolveModelFlag } from '../../model/models/model-resolution.js';
import { isProviderDisabled, resolveProviderCredentials } from '../../model/provider-credentials.js';
import { fetchModels, peekCachedModels } from '../../model/model-service.js';
import type { ModelRef } from '../../model/index.js';
import type { AcpApprovalMode, AcpIo } from '../../clients/acp/index.js';
import type { WireConfigureRequest, WireModel } from '../../protocol/wire.js';
import type { DirectApprovalMode } from '../config-settings.js';
import type { DirectLaunchRequest } from '../launch-types.js';
import type { DirectRuntimeOptions } from '../application-runtime.js';

export type AcpRequest = Extract<DirectLaunchRequest, { readonly kind: 'acp' }>;
type Settings = AcpRequest['selection']['settings'];

/** What `--provider/--model/--effort` chose for new sessions; empty when no flag was given. */
export type AcpModelFlags = {
  readonly model?: ModelRef;
  readonly reasoning?: NonNullable<WireConfigureRequest['reasoning']>;
};

export const nativeApprovalMode = {
  ask: 'off',
  assisted: 'auto',
  unattended: 'unattended',
  always: 'always',
} as const satisfies Record<AcpApprovalMode, DirectApprovalMode>;

export function acpApprovalMode(native: unknown): AcpApprovalMode {
  return native === 'always'
    ? 'always'
    : native === 'unattended'
    ? 'unattended'
    : native === 'auto'
    ? 'assisted'
    : 'ask';
}

/**
 * An ACP session starts in Ask mode, needs the sandbox, and keeps its model and
 * effort changes out of the user's saved defaults, in whichever host runs it.
 */
export const ACP_SESSION_POLICY = {
  approvalAlwaysAsks: true,
  requireSandbox: true,
  persistSessionConfiguration: false,
} as const satisfies Pick<
  DirectRuntimeOptions,
  'approvalAlwaysAsks' | 'requireSandbox' | 'persistSessionConfiguration'
>;

/** Applies `--provider/--model/--effort` for this process only. Returns false after reporting a refusal. */
export async function applyAcpModelFlags({ args, selection }: AcpRequest, io: AcpIo): Promise<false | AcpModelFlags> {
  const { settings, logger } = selection;
  if (args.effort) settings.set('agent.reasoningEffort', args.effort, { persist: false });
  if (args.provider && !getProviderIds().includes(args.provider)) {
    io.writeStderr(`term2 acp: unknown provider "${args.provider}".`);
    io.writeStderr('Available providers:');
    for (const provider of getAllProviders()) io.writeStderr(`  - ${provider.id}  (${provider.label})`);
    return false;
  }
  if (args.provider && !args.model) {
    io.writeStderr('term2 acp: --provider requires --model; provider-only selection is not supported.');
    return false;
  }
  if (!args.model) return args.effort ? { reasoning: args.effort } : {};
  // The default prompter reads the terminal, but stdin carries JSON-RPC. A null
  // answer makes an ambiguous pattern fail instead of consuming protocol bytes.
  const resolution = await resolveModelFlag({
    modelFlag: args.model,
    ...(args.provider ? { providerFlag: args.provider } : {}),
    settingsService: settings,
    loggingService: logger,
    prompter: async () => null,
  });
  if (resolution.status === 'no_match') {
    io.writeStderr(`term2 acp: ${resolution.error}`);
    return false;
  }
  if (resolution.status === 'cancelled') {
    io.writeStderr(
      `term2 acp: cannot resolve --model "${args.model}" non-interactively; pass an exact model id or <provider>/<model>.`,
    );
    return false;
  }
  for (const warning of ('warnings' in resolution && resolution.warnings) || []) io.writeStderr(warning);
  const model = { model: resolution.modelId, provider: resolution.provider };
  settings.set('agent.modelSelection', model, { persist: false });
  if (resolution.reasoningEffort && !args.effort) {
    settings.set('agent.reasoningEffort', resolution.reasoningEffort, { persist: false });
  }
  const reasoning = args.effort ?? resolution.reasoningEffort;
  return { model, ...(reasoning ? { reasoning: reasoning as AcpModelFlags['reasoning'] } : {}) };
}

/** Providers an ACP client may pick from: streamable, enabled and configured. */
function selectableAcpProviders(settings: Settings) {
  return getAllProviders().filter(
    (provider) =>
      provider.createStreamedModel &&
      !isProviderDisabled(settings, provider.id) &&
      resolveProviderCredentials(settings, provider.id).configured,
  );
}

/** A session may move only to a cached model of a selectable provider. */
export function authorizeAcpModel(settings: Settings, next: ModelRef, previous: ModelRef): void {
  if (next.provider === previous.provider && next.model === previous.model) return;
  if (
    selectableAcpProviders(settings).some((provider) => provider.id === next.provider) &&
    peekCachedModels(next.provider)?.some((model) => model.id === next.model)
  )
    return;
  throw new Error('Model is not available from a configured ACP provider.');
}

/** Cache-only unless `refresh`; one discovery at a time. */
export function createAcpModelCatalog(selection: AcpRequest['selection'], signal: AbortSignal) {
  let discovery: Promise<readonly (WireModel & { name?: string })[]> | undefined;
  return async (refresh: boolean) => {
    const providers = selectableAcpProviders(selection.settings);
    const rows = (provider: string, entries: readonly { id: string; name?: string }[]) =>
      entries.map((entry) => ({ provider, model: entry.id, ...(entry.name ? { name: entry.name } : {}) }));
    if (!refresh) return providers.flatMap((provider) => rows(provider.id, peekCachedModels(provider.id) ?? []));
    discovery ??= Promise.all(
      providers.map(async (provider) => {
        try {
          return rows(
            provider.id,
            await fetchModels(
              { settingsService: selection.settings, loggingService: selection.logger, signal },
              provider.id,
            ),
          );
        } catch {
          return rows(provider.id, peekCachedModels(provider.id) ?? []);
        }
      }),
    )
      .then((groups) => groups.flat())
      .finally(() => {
        discovery = undefined;
      });
    return await discovery;
  };
}
