/** One headless run as a client of the direct host. `cli.ts` owns signals, as it does for any `RunHandle`. */
import fs from 'node:fs';
import { runDirectHeadless } from '../clients/headless/index.js';
import { createDirectApplication, type DirectApplication } from './direct-application.js';
import { openDirectSessionTarget, type DirectSessionTarget } from './direct-application-target.js';
import type { DirectHeadlessHandle, DirectHeadlessRequest, DirectHeadlessResult } from './direct-launch-types.js';

export function runDirectHeadlessOnHost(request: DirectHeadlessRequest): DirectHeadlessHandle {
  const stop = new AbortController();
  let active = false;

  const execute = async (): Promise<DirectHeadlessResult> => {
    const { io, prompt, resumeId, conversationsDir, selection, autoApprove = false, output = 'plain' } = request;
    let application: DirectApplication | null = null;
    let target: DirectSessionTarget | null = null;
    let profileMetadata: Readonly<Record<string, unknown>> = {};
    try {
      const opened = await openDirectSessionTarget(request.ssh, request.lite === true, stop.signal);
      target = opened;
      const app = await createDirectApplication({
        conversationsDir,
        selection,
        ...(request.profileExplicit !== undefined ? { profileExplicit: request.profileExplicit } : {}),
        surface: () => ({ autoApprove, interactive: false, ...opened.surface }),
        authority: opened.authority,
        ...(opened.binding ? { sessionBinding: opened.binding } : {}),
        hooks: { root: fs.realpathSync(process.cwd()), mode: 'non-interactive' },
        onSurface(surface, profile) {
          profileMetadata = profile;
          io.stderr.write(`Profile: ${surface.profileName}\n`);
        },
      });
      application = app;
      const connection =
        resumeId === undefined
          ? await app.host.createSession(app.principal, opened.grant)
          : await app.host.connect(app.principal, resumeId);
      active = true;
      const { outcome } = await runDirectHeadless(connection, {
        prompt,
        io,
        output,
        autoApprove,
        profileMetadata,
        ...(request.showReasoning === undefined ? {} : { showReasoning: request.showReasoning }),
        ...(request.quiet === undefined ? {} : { quiet: request.quiet }),
        signal: stop.signal,
        decideApproval: app.headlessPolicy(connection.sessionId, autoApprove, stop.signal),
        ...(resumeId === undefined ? {} : { expectedSessionId: resumeId }),
      });
      switch (outcome) {
        case 'completed':
        case 'cancelled':
        case 'context_paused':
        case 'blocked':
          return { kind: outcome };
        default:
          return { kind: 'failed' };
      }
    } catch (error) {
      io.stderr.write(`error ${error instanceof Error ? error.message : String(error)}\n`);
      return { kind: 'failed' };
    } finally {
      try {
        await application?.close();
        await target?.close();
      } catch {
        // The durable terminal, or the failure to write it, has already decided the result.
      } finally {
        active = false;
      }
    }
  };

  return {
    result: execute(),
    turnActive: () => active,
    cancel: () => stop.abort(),
  };
}
