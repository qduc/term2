/** One headless run as a client of the direct host. `cli.ts` owns signals, through the returned handle. */
import fs from 'node:fs';
import process from 'node:process';
import { probeTerminal } from '../clients/terminal-probe.js';
import { openDirectApplicationMcp } from './application-mcp.js';
import type { DirectMcp } from './mcp.js';
import { runDirectHeadless } from '../clients/headless/index.js';
import { createDirectApplication, type DirectApplication } from './application.js';
import { openDirectSessionTarget, type DirectSessionTarget } from './application-target.js';
import type { DirectHeadlessHandle, DirectHeadlessRequest, DirectHeadlessResult } from './launch-types.js';
import { displaySessionId } from '../protocol/session-id.js';
import { LOCAL_PRINCIPAL, localGrant } from './application-workspaces.js';
import { connectRemoteDirectHost } from './daemon/connect-daemon-host.js';

function mapHeadlessOutcome(outcome: string): DirectHeadlessResult {
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
}

async function runHeadlessOverDaemon(
  request: DirectHeadlessRequest,
  stop: AbortController,
  setActive: (value: boolean) => void,
): Promise<DirectHeadlessResult> {
  const { io, prompt, resumeId, conversationsDir, selection, autoApprove = false, output = 'plain' } = request;
  const connected = await connectRemoteDirectHost({
    clientKind: 'headless',
    conversationsDir,
    defaultApprovalPolicy: { mode: 'headless', autoApprove },
    env: process.env,
  });
  try {
    const sessionId =
      resumeId !== undefined && request.fork ? (await connected.host.forkSession(resumeId)).id : resumeId;
    if (sessionId !== resumeId) {
      io.stderr.write(`Forked conversation ${displaySessionId(resumeId!)} → ${displaySessionId(sessionId!)}\n`);
    }
    const connection =
      sessionId === undefined
        ? await connected.host.createSession(LOCAL_PRINCIPAL, localGrant(fs.realpathSync(process.cwd())))
        : await connected.host.connect(LOCAL_PRINCIPAL, sessionId);
    try {
      setActive(true);
      const { outcome } = await runDirectHeadless(connection, {
        prompt,
        io,
        output,
        autoApprove,
        backgroundWaitTimeoutMs: selection.settings.get('agent.backgroundWaitTimeoutMs'),
        ...(request.showReasoning === undefined ? {} : { showReasoning: request.showReasoning }),
        ...(request.quiet === undefined ? {} : { quiet: request.quiet }),
        signal: stop.signal,
        sessionHandlesHeadlessApprovals: true,
        ...(sessionId === undefined ? {} : { expectedSessionId: sessionId }),
      });
      return mapHeadlessOutcome(outcome);
    } finally {
      connection.close();
      setActive(false);
    }
  } finally {
    await connected.host.dispose();
  }
}

export function runDirectHeadlessOnHost(request: DirectHeadlessRequest): DirectHeadlessHandle {
  const stop = new AbortController();
  let active = false;

  const execute = async (): Promise<DirectHeadlessResult> => {
    const { io, prompt, resumeId, conversationsDir, selection, autoApprove = false, output = 'plain' } = request;
    if (
      process.env['TERM2_DAEMON_MODE'] === '1' &&
      process.env['TERM2_IN_PROCESS'] !== '1' &&
      !request.ssh &&
      !request.lite &&
      !request.goal &&
      !(resumeId !== undefined && request.resumeConfiguration)
    ) {
      try {
        return await runHeadlessOverDaemon(request, stop, (v) => {
          active = v;
        });
      } catch (error) {
        io.stderr.write(`error ${error instanceof Error ? error.message : String(error)}\n`);
        return { kind: 'failed' };
      }
    }
    let application: DirectApplication | null = null;
    let target: DirectSessionTarget | null = null;
    let mcp: DirectMcp | undefined;
    let profileMetadata: Readonly<Record<string, unknown>> = {};
    // Only a run attached to a terminal on both ends is probed (e.g. inside hc);
    // pipes and redirects answer "no" at once. Sent first so it overlaps startup.
    const programStatus = probeTerminal({
      stdin: process.stdin,
      stdout: process.stdout,
      background: false,
      programStatus: true,
    }).then((result) => result.programStatus);
    try {
      const opened = await openDirectSessionTarget(request.ssh, request.lite === true, stop.signal);
      target = opened;
      mcp = await openDirectApplicationMcp({
        target: opened,
        conversationsDir,
        interactive: false,
        onNotice: (message) => {
          // MCP setup notices are non-error diagnostics, suppressed by --quiet.
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
        surface: () => ({ autoApprove, interactive: false, sessionBrowser: false, ...opened.surface, mcp }),
        mcpCatalog: null,
        authority: opened.authority,
        ...(opened.binding ? { sessionBinding: opened.binding } : {}),
        hooks: { root: fs.realpathSync(process.cwd()), mode: 'non-interactive', programStatus },
        onSurface(_surface, profile) {
          profileMetadata = profile;
        },
      });
      application = app;
      const sessionId = resumeId !== undefined && request.fork ? await app.forkSession(resumeId) : resumeId;
      // The old CLI prints this under --quiet too. It is the fork's identity, not a diagnostic.
      if (sessionId !== resumeId)
        io.stderr.write(`Forked conversation ${displaySessionId(resumeId!)} → ${displaySessionId(sessionId!)}\n`);
      if (sessionId !== undefined && request.resumeConfiguration)
        await app.applyLaunchConfiguration(sessionId, request.resumeConfiguration);
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
        sessionHandlesHeadlessApprovals: true,
        ...(sessionId === undefined ? {} : { expectedSessionId: sessionId }),
      });
      return mapHeadlessOutcome(outcome);
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
