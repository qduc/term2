/**
 * Public hooks on the direct host. Discovery and the runner are the existing
 * ones. Sessions retain their turn/tool observers; the app owns the public root
 * lifetime, including empty resumes and /clear. Client disconnect is not shutdown.
 *
 * The same root lifecycle drives OSC 7501 program status when the terminal
 * answered the probe (`programStatus`), so Ghostty, Rex or hc can show it.
 */
import { writeSync } from 'node:fs';
import { createRootHookRuntime } from '../session/hooks/hook-composition.js';
import type { Term2SessionMode, Term2Status } from '../session/hooks/hook-contracts.js';
import { createProgramStatusReporter, type ProgramStatusReporter } from '../shared/utils/output/program-status.js';
import { createDirectHooks } from '../session/hooks.js';
import type { DirectRuntimeContext } from '../session/store.js';
import type { ProfileSelection } from './tool-contract.js';

export type DirectHookOptions = {
  readonly root: string;
  readonly mode: Term2SessionMode;
  /** The terminal's answer to the OSC 7501 probe; absent or false writes nothing. */
  readonly programStatus?: Promise<boolean>;
};

function reportStatus(reporter: ProgramStatusReporter, status: Term2Status): void {
  switch (status) {
    case 'idle':
    case 'working':
      return reporter.report(status);
    case 'waiting_for_user':
      return reporter.report('blocked', 'question');
    case 'waiting_for_approval':
      return reporter.report('blocked', 'permission');
  }
}

export type DirectHookRuntime = {
  session(context: DirectRuntimeContext, settings: ProfileSelection['settings']): ReturnType<typeof createDirectHooks>;
  close(): Promise<void>;
};

export async function startDirectHooks(
  { root, mode, programStatus }: DirectHookOptions,
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
  // Synchronous, so the final report reaches the terminal before the process exits.
  const status = programStatus
    ? createProgramStatusReporter(programStatus, (data) => void writeSync(process.stdout.fd, data), 'term2')
    : undefined;

  let rootObserver: ReturnType<typeof createDirectHooks> | undefined;
  let started: Promise<void> | undefined;
  let reason: 'normal' | 'fatal_error' = 'normal';
  // Borrowed per-Session port: a Session can end its observer, not the app's
  // root lifecycle or shared runner. Turn/tool events keep native correlation.
  const sessionLifecycle = {
    async emit(event: Parameters<typeof hookService.emit>[0]) {
      if (status && event.type === 'status.change' && event.scope === 'root') reportStatus(status, event.current);
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
        status?.report('idle');
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
      // The spec keeps `done`/`error` after exit: a headless result or a failure
      // is still unseen. Quitting an interactive session leaves nothing unseen,
      // so remove the record instead of leaving it on the shell term2 ran in.
      if (status && rootObserver) {
        if (reason === 'fatal_error') status.report('error');
        else if (mode === 'interactive') status.clear();
        else status.report('done');
      }
      await status?.settled();
      await hookService.shutdown();
    },
  };
}
