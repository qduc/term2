/**
 * `term2 acp` on the direct host. stdout is the protocol channel and nothing else
 * writes to it. ACP v1 starts in Ask mode and may change its session approval policy.
 * The v2 shell stays in the required sandbox.
 */
import fs from 'node:fs';
import { installationVersion } from '../../model/providers/fetch/logging-middleware.js';
import {
  createAcpBackend,
  createStdioAcpIo,
  serveAcp,
  type AcpApprovalMode,
  type AcpWorkspaces,
} from '../../clients/acp/index.js';
import { createDirectApplication, type DirectApplication } from '../application.js';
import { createLocalAuthority, LOCAL_PRINCIPAL, localGrant } from '../application-workspaces.js';
import { warnIfSandboxUnavailable } from '../sandbox-warning.js';
import { createAcpSessions } from './acp-sessions.js';
import {
  ACP_SESSION_POLICY,
  acpApprovalMode,
  applyAcpModelFlags,
  authorizeAcpModel,
  createAcpModelCatalog,
  nativeApprovalMode,
  type AcpRequest,
} from './acp-common.js';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  // Opt-in until the Step 14f flip; TERM2_IN_PROCESS=1 always keeps the in-process host.
  if (process.env['TERM2_DAEMON_MODE'] === '1' && process.env['TERM2_IN_PROCESS'] !== '1')
    return await (await import('./launch-acp-daemon.js')).launchAcpOverDaemon(request);
  const io = createStdioAcpIo();
  if (!(await applyAcpModelFlags(request, io))) return 1;
  await warnIfSandboxUnavailable('acp', (line) => io.writeStderr(line));

  const { conversationsDir, selection } = request;
  const sessions = createAcpSessions();
  let protocolVersion: 1 | 2 = 2;
  const app = await createDirectApplication({
    conversationsDir,
    selection,
    surface: (sessionId) => ({
      autoApprove: false,
      interactive: true,
      sessionBrowser: false,
      allowUnsandboxed: false,
      shellEscapeApproval: protocolVersion === 1,
      mcp: sessions.surface(sessionId),
    }),
    mcpCatalog: sessions,
    hooks: null,
    ...ACP_SESSION_POLICY,
    authorizeModel: (next, previous) => authorizeAcpModel(selection.settings, next, previous),
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
  const models = createAcpModelCatalog(selection, shutdown.signal);
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
      approval: {
        async get(sessionId): Promise<AcpApprovalMode> {
          return acpApprovalMode((await app.sessionConfiguration(sessionId)).approvalMode);
        },
        async set(sessionId, mode) {
          if (protocolVersion !== 1) throw new Error('Approval mode is available only in ACP v1.');
          await app.applyLaunchConfiguration(sessionId, {}, nativeApprovalMode[mode]);
        },
      },
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
