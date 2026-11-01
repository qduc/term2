/**
 * Public hooks on the direct host. Discovery and the runner are the existing
 * ones. Sessions retain their turn/tool observers; the app owns the public root
 * lifetime, including empty resumes and /clear. Client disconnect is not shutdown.
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

  let rootObserver: ReturnType<typeof createDirectHooks> | undefined;
  let started: Promise<void> | undefined;
  let reason: 'normal' | 'fatal_error' = 'normal';
  // Borrowed per-Session port: a Session can end its observer, not the app's
  // root lifecycle or shared runner. Turn/tool events keep native correlation.
  const sessionLifecycle = {
    async emit(event: Parameters<typeof hookService.emit>[0]) {
      await started;
      if (event.type !== 'session.start' && event.type !== 'session.end') await hookService.emit(event);
    },
    async shutdown() {},
  };
  return {
    session(context, sessionSettings) {
      const options = {
        sessionId: context.id,
        cwd,
        mode,
        model: context.model,
        includeUserText: sessionSettings.getDynamic('hooks.includeUserText') === true,
        includeToolArguments: sessionSettings.getDynamic('hooks.includeToolArguments') === true,
        includeToolResults: sessionSettings.getDynamic('hooks.includeToolResults') === true,
        diagnostic: (message: string, error: unknown) => logger.warn(message, { error: String(error) }),
      };
      if (!rootObserver) {
        rootObserver = createDirectHooks({ ...options, lifecycle: hookService });
        // Attachment, not first provider work, starts even an empty resumed root.
        started = rootObserver.start();
      }
      const observer = createDirectHooks({ ...options, lifecycle: sessionLifecycle });
      return {
        ...observer,
        async end(endedReason?: 'normal' | 'fatal_error', at?: number) {
          if (endedReason === 'fatal_error') reason = endedReason;
          await observer.end(endedReason, at);
        },
      };
    },
    async close() {
      await started;
      await rootObserver?.end(reason);
      await hookService.shutdown();
    },
  };
}
