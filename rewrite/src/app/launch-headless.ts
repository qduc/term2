/** One headless run as a client of the direct host. `cli.ts` owns signals, through the returned handle. */
import fs from 'node:fs';
import { openDirectApplicationMcp } from './application-mcp.js';
import type { DirectMcp } from './mcp.js';
import { runDirectHeadless } from '../clients/headless/index.js';
import { createDirectApplication, type DirectApplication } from './application.js';
import { openDirectSessionTarget, type DirectSessionTarget } from './application-target.js';
import type { DirectHeadlessHandle, DirectHeadlessRequest, DirectHeadlessResult } from './launch-types.js';
import { displaySessionId } from '../protocol/session-id.js';

export function runDirectHeadlessOnHost(request: DirectHeadlessRequest): DirectHeadlessHandle {
  const stop = new AbortController();
  let active = false;

  const execute = async (): Promise<DirectHeadlessResult> => {
    const { io, prompt, resumeId, conversationsDir, selection, autoApprove = false, output = 'plain' } = request;
    let application: DirectApplication | null = null;
    let target: DirectSessionTarget | null = null;
    let mcp: DirectMcp | undefined;
    let profileMetadata: Readonly<Record<string, unknown>> = {};
    try {
      const opened = await openDirectSessionTarget(request.ssh, request.lite === true, stop.signal);
      target = opened;
      mcp = await openDirectApplicationMcp({
        target: opened,
        conversationsDir,
        interactive: false,
        onNotice: (message) => {
          // Same non-error diagnostic as the profile line. The old CLI only logs these.
          if (!request.quiet) io.stderr.write(`MCP: ${message}\n`);
        },
      });
      // Headless owns one frozen generation; settle BEFORE first surface/session.
      await mcp?.whenSettled();
      stop.signal.throwIfAborted();
      const app = await createDirectApplication({
        conversationsDir,
        selection,
        ...(request.profileExplicit !== undefined ? { profileExplicit: request.profileExplicit } : {}),
        surface: () => ({ autoApprove, interactive: false, ...opened.surface, ...(mcp ? { mcp } : {}) }),
        authority: opened.authority,
        ...(opened.binding ? { sessionBinding: opened.binding } : {}),
        hooks: { root: fs.realpathSync(process.cwd()), mode: 'non-interactive' },
        onSurface(surface, profile) {
          profileMetadata = profile;
          // `--quiet` suppresses non-error diagnostics. Later event lines already
          // honor it; this announcement is written before that run starts.
          if (!request.quiet) io.stderr.write(`Profile: ${surface.profileName}\n`);
        },
      });
      application = app;
      const sessionId = resumeId !== undefined && request.fork ? await app.forkSession(resumeId) : resumeId;
      // The old CLI prints this under --quiet too. It is the fork's identity, not a diagnostic.
      if (sessionId !== resumeId)
        io.stderr.write(`Forked conversation ${displaySessionId(resumeId!)} → ${displaySessionId(sessionId!)}\n`);
      const connection =
        sessionId === undefined
          ? await app.host.createSession(app.principal, opened.grant)
          : await app.host.connect(app.principal, sessionId);
      if (request.goal) await app.setGoal(connection.sessionId, request.goal, 'launcher');
      active = true;
      const { outcome } = await runDirectHeadless(connection, {
        prompt,
        io,
        output,
        autoApprove,
        profileMetadata,
        backgroundWaitTimeoutMs: selection.settings.get('agent.backgroundWaitTimeoutMs'),
        ...(request.showReasoning === undefined ? {} : { showReasoning: request.showReasoning }),
        ...(request.quiet === undefined ? {} : { quiet: request.quiet }),
        signal: stop.signal,
        decideApproval: app.headlessPolicy(connection.sessionId, autoApprove, stop.signal),
        ...(sessionId === undefined ? {} : { expectedSessionId: sessionId }),
      });
      switch (outcome) {
        case 'completed':
        case 'cancelled':
        case 'context_paused':
        case 'blocked':
        case 'budget_paused':
          return { kind: outcome };
        default:
          return { kind: 'failed' };
      }
    } catch (error) {
      io.stderr.write(`error ${error instanceof Error ? error.message : String(error)}\n`);
      return { kind: 'failed' };
    } finally {
      try {
        try {
          await application?.close();
        } finally {
          try {
            await mcp?.close();
          } finally {
            await target?.close();
          }
        }
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
