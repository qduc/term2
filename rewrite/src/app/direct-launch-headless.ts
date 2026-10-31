/** One headless run as a client of the direct host. `cli.ts` owns signals, as it does for any `RunHandle`. */
import fs from 'node:fs';
import { runDirectHeadless } from '../clients/headless/index.js';
import { createDirectApplication, type DirectApplication } from './direct-application.js';
import { createLocalAuthority, localGrant } from './direct-application-workspaces.js';
import type { DirectHeadlessRequest } from './direct-launch-types.js';
import type { RunHandle, RunResult } from './run-types.js';

export function runDirectHeadlessOnHost(request: DirectHeadlessRequest): RunHandle {
  const stop = new AbortController();
  let active = false;

  const execute = async (): Promise<RunResult> => {
    const { io, prompt, resumeId, conversationsDir, selection, autoApprove = false, output = 'plain' } = request;
    let application: DirectApplication | null = null;
    let profileMetadata: Readonly<Record<string, unknown>> = {};
    try {
      const root = fs.realpathSync(process.cwd());
      const app = await createDirectApplication({
        conversationsDir,
        selection,
        ...(request.profileExplicit !== undefined ? { profileExplicit: request.profileExplicit } : {}),
        surface: { autoApprove, interactive: false },
        authority: createLocalAuthority((candidate) => candidate === root),
        hooks: { root, mode: 'non-interactive' },
        onSurface(surface, profile) {
          profileMetadata = profile;
          if (output === 'plain') io.stderr.write(`Profile: ${surface.profileName}\n`);
        },
      });
      application = app;
      const connection =
        resumeId === undefined
          ? await app.host.createSession(app.principal, localGrant(root))
          : await app.host.connect(app.principal, resumeId);
      active = true;
      const { outcome } = await runDirectHeadless(connection, {
        prompt,
        io,
        output,
        autoApprove,
        profileMetadata,
        ...(request.showReasoning === undefined ? {} : { showReasoning: request.showReasoning }),
        signal: stop.signal,
        decideApproval: app.headlessPolicy(connection.sessionId, autoApprove, stop.signal),
        ...(resumeId === undefined ? {} : { expectedSessionId: resumeId }),
      });
      return { kind: outcome === 'completed' || outcome === 'cancelled' ? outcome : 'failed' };
    } catch (error) {
      io.stderr.write(`error ${error instanceof Error ? error.message : String(error)}\n`);
      return { kind: 'failed' };
    } finally {
      try {
        await application?.close();
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
