/**
 * Public hooks on the direct host. Discovery and the runner are the existing
 * ones. The Session calls them in commit order and ends them after its work has
 * drained, so a hook can never change what a turn does.
 */
import { createRootHookRuntime } from '../../../source/services/hooks/hook-composition.js';
import type { Term2SessionMode } from '../../../source/services/hooks/hook-contracts.js';
import { createDirectHooks } from '../session/direct-hooks.js';
import type { DirectRuntimeContext } from '../session/direct-store.js';
import type { ProfileSelection } from './tool-contract.js';

export type DirectHookOptions = { readonly root: string; readonly mode: Term2SessionMode };

export type DirectHookRuntime = {
  session(context: DirectRuntimeContext, settings: ProfileSelection['settings']): ReturnType<typeof createDirectHooks>;
  close(): Promise<void>;
};

export async function startDirectHooks(
  { root, mode }: DirectHookOptions,
  { settings, logger }: ProfileSelection,
): Promise<DirectHookRuntime> {
  const { cwd, hookService } = createRootHookRuntime({
    executionContext: { getCwd: () => root, isRemote: () => false },
    userEnabled: settings.getDynamic('hooks.user.enabled') !== false,
    projectEnabled: settings.getDynamic('hooks.project.enabled') !== false,
    trustedProjectRoots: (settings.getDynamic('hooks.trustedProjectRoots') as string[] | undefined) ?? [],
    registryOptions: { callbackTimeoutMs: Number(settings.getDynamic('hooks.timeoutMs') ?? 5_000) },
    logger(diagnostic) {
      logger.warn('Public hook diagnostic', {
        eventType: `hooks.${diagnostic.code}`,
        category: 'application',
        ...diagnostic,
      });
    },
  });
  await hookService.initialize();

  return {
    session: (context, sessionSettings) =>
      createDirectHooks({
        sessionId: context.id,
        cwd,
        mode,
        model: context.model,
        lifecycle: hookService,
        includeUserText: sessionSettings.getDynamic('hooks.includeUserText') === true,
        includeToolArguments: sessionSettings.getDynamic('hooks.includeToolArguments') === true,
        includeToolResults: sessionSettings.getDynamic('hooks.includeToolResults') === true,
        diagnostic: (message, error) => logger.warn(message, { error: String(error) }),
      }),
    close: () => hookService.shutdown(),
  };
}
