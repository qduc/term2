/**
 * `term2 acp` on the direct host. stdout is the protocol channel and nothing else
 * writes to it. The shell defaults to the required sandbox. ACP v1 can request
 * an explicit one-time grant for a foreground shell command outside it.
 */
import fs from 'node:fs';
import { getAllProviders, getProviderIds } from '../model/providers/index.js';
import { installationVersion } from '../model/providers/fetch/logging-middleware.js';
import { resolveModelFlag } from '../model/models/model-resolution.js';
import { createAcpBackend, createStdioAcpIo, serveAcp, type AcpIo, type AcpWorkspaces } from '../clients/acp/index.js';
import { createDirectApplication, type DirectApplication } from './application.js';
import { createLocalAuthority, LOCAL_PRINCIPAL, localGrant } from './application-workspaces.js';
import type { DirectLaunchRequest } from './launch-types.js';
import { warnIfSandboxUnavailable } from './sandbox-warning.js';
import { isProviderDisabled, resolveProviderCredentials } from '../model/provider-credentials.js';
import { fetchModels, peekCachedModels } from '../model/model-service.js';
import type { WireModel } from '../protocol/wire.js';
import { createAcpSessions } from './acp-sessions.js';

type AcpRequest = Extract<DirectLaunchRequest, { readonly kind: 'acp' }>;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Applies `--provider/--model/--effort` for this process only. Returns false after reporting a refusal. */
async function applyModelFlags({ args, selection }: AcpRequest, io: AcpIo): Promise<boolean> {
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
  if (!args.model) return true;
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
  settings.set(
    'agent.modelSelection',
    { model: resolution.modelId, provider: resolution.provider },
    { persist: false },
  );
  if (resolution.reasoningEffort && !args.effort) {
    settings.set('agent.reasoningEffort', resolution.reasoningEffort, { persist: false });
  }
  return true;
}

/** An ACP client names its cwd per session; any real directory is admitted, as today. */
function acpWorkspaces(app: DirectApplication): AcpWorkspaces {
  return {
    async authorize(cwd) {
      return localGrant(fs.realpathSync(cwd));
    },
    cwd: (sessionId) => app.sessionRoot(LOCAL_PRINCIPAL, sessionId),
  };
}

export async function launchAcp(request: AcpRequest): Promise<number> {
  const io = createStdioAcpIo();
  if (!(await applyModelFlags(request, io))) return 1;
  await warnIfSandboxUnavailable('acp', (line) => io.writeStderr(line));

  const { conversationsDir, selection } = request;
  const selectableProviders = () =>
    getAllProviders().filter(
      (provider) =>
        provider.createStreamedModel &&
        !isProviderDisabled(selection.settings, provider.id) &&
        resolveProviderCredentials(selection.settings, provider.id).configured,
    );
  const sessions = createAcpSessions();
  let protocolVersion: 1 | 2 = 2;
  const app = await createDirectApplication({
    conversationsDir,
    selection,
    surface: (sessionId) => ({
      autoApprove: false,
      interactive: true,
      allowUnsandboxed: false,
      shellEscapeApproval: protocolVersion === 1,
      mcp: sessions.surface(sessionId),
    }),
    mcpCatalog: sessions,
    approvalAlwaysAsks: true,
    requireSandbox: true,
    persistSessionConfiguration: false,
    authorizeModel(next, previous) {
      if (next.provider === previous.provider && next.model === previous.model) return;
      if (
        selectableProviders().some((provider) => provider.id === next.provider) &&
        peekCachedModels(next.provider)?.some((model) => model.id === next.model)
      )
        return;
      throw new Error('Model is not available from a configured ACP provider.');
    },
    authority: createLocalAuthority((root) => {
      try {
        return fs.statSync(root).isDirectory();
      } catch {
        return false;
      }
    }),
  });

  const shutdown = new AbortController();
  const onSignal = (): void => shutdown.abort();
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  let exitCode = 1;
  let discovery: Promise<readonly (WireModel & { name?: string })[]> | undefined;
  const models = async (refresh: boolean) => {
    const providers = selectableProviders();
    const rows = (provider: string, entries: readonly { id: string; name?: string }[]) =>
      entries.map((entry) => ({ provider, model: entry.id, ...(entry.name ? { name: entry.name } : {}) }));
    if (!refresh) return providers.flatMap((provider) => rows(provider.id, peekCachedModels(provider.id) ?? []));
    discovery ??= Promise.all(
      providers.map(async (provider) => {
        try {
          return rows(
            provider.id,
            await fetchModels(
              {
                settingsService: selection.settings,
                loggingService: selection.logger,
                signal: shutdown.signal,
              },
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
  try {
    const logger = {
      error: (message: string, fields: Readonly<Record<string, unknown>>) => selection.logger.error(message, fields),
    };
    const backend = createAcpBackend({
      host: app.host,
      principal: app.principal,
      workspaces: acpWorkspaces(app),
      logger,
      models,
      sessions,
      async configuration(sessionId) {
        const state = await app.sessionConfiguration(sessionId);
        return { model: state.model, reasoning: state.reasoningEffort };
      },
    });
    exitCode = await serveAcp(
      {
        backend,
        logger,
        version: installationVersion,
        onProtocolVersion: (version) => {
          protocolVersion = version;
        },
      },
      io,
      shutdown.signal,
    );
  } finally {
    shutdown.abort();
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    try {
      await sessions.drain();
      await app.close();
    } catch (error) {
      io.writeStderr(`term2 acp: shutdown failed: ${messageOf(error)}`);
      exitCode = 1;
    }
    await sessions.shutdown();
  }
  return exitCode;
}
