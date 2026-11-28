import { executeShellCommand } from '../tools/shell/execute-shell.js';
import { formatShellExecutionOutput } from '../shared/utils/shell/shell-output.js';
/** The interactive terminal client on the direct host. The app owns the connection and replaces it across sessions. */
import fs from 'node:fs';
import { stderr, stdin, stdout } from 'node:process';
import React, { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { Box, render } from 'ink';
import Banner from '../clients/tui/presentation/components/layout/Banner.js';
import { SettingsSkinProvider } from '../clients/tui/presentation/skins/SkinContext.js';
import { SettingsThemeProvider } from '../clients/tui/presentation/theme/ThemeContext.js';
import { getInkRenderOptions } from '../shared/utils/ink-render-options.js';
import { getProvider } from '../model/providers/registry.js';
import type { WireSnapshot } from '../protocol/wire.js';
import {
  TuiServicesProvider,
  useTerminalFocusNotifier,
} from '../clients/tui/presentation/hooks/use-terminal-focus-notifier.js';
import { useSetting } from '../clients/tui/presentation/hooks/use-setting.js';
import type { LoggingService } from '../session/logging/logging-service.js';
import { Tui, type TuiIntegration } from '../clients/tui/index.js';
import type { DirectConnection, DirectReplayConnection } from '../host/in-process-direct-types.js';
import { createDirectApplication } from './application.js';
import { openDirectSessionTarget, type DirectSessionTarget } from './application-target.js';
import { createDirectControlBridge, type DirectControlBridge } from './launch-control.js';
import { createDirectTuiCommands } from './launch-tui-commands.js';
import { printUsage } from './usage-report.js';
import { createDirectTuiMenus } from './launch-tui-menus.js';
import { performRestart, type DirectRestartPlan } from './launch-tui-restart.js';
import type { DirectLaunchRequest } from './launch-types.js';
import type { TerminalBackground, TerminalProgramStatus } from './launch-tui-terminal.js';
import type { ILoggingService, ISettingsService } from '../shared/service-interfaces.js';
import { INTERACTIVE_TERMINAL_REQUIRED } from './launch.js';
import { openDirectApplicationMcp } from './application-mcp.js';
import type { DirectMcp } from './mcp.js';
import { displaySessionId } from '../protocol/session-id.js';
import { createInProcessTuiBackend, type TuiBackend } from './lib/tui-backend.js';
import { runDaemonTuiSession } from './daemon/daemon-tui-backend.js';

type InteractiveRequest = Extract<DirectLaunchRequest, { readonly kind: 'interactive' }>;
type TerminalProbe = { readonly background: TerminalBackground; readonly programStatus: TerminalProgramStatus };
type ActiveConnection = DirectConnection | DirectReplayConnection;

function DirectTui({
  unconfiguredSessionId,
  backend,
  root,
  remote,
  initial,
  bridge,
  restart,
  onExit,
  logger,
}: {
  readonly backend: TuiBackend;
  readonly root: string;
  readonly remote: DirectSessionTarget['restart'];
  readonly initial: DirectConnection;
  readonly unconfiguredSessionId?: string;
  readonly bridge: DirectControlBridge;
  readonly restart: (plan: DirectRestartPlan) => void;
  readonly onExit: (snapshot: WireSnapshot) => void;
  readonly logger: LoggingService;
}): React.ReactElement {
  const [connection, setConnection] = useState<ActiveConnection>(initial);
  const [retained, setRetained] = useState<WireSnapshot | undefined>(undefined);
  // The notifier already owns terminal focus and all three preference gates.
  // Never use launch defaults: attached sessions own separate mutable settings.
  const settings = backend.liveSettings(connection.sessionId);
  if (!settings) throw new Error('The attached session has no live settings.');
  return (
    <TuiServicesProvider settingsService={settings} loggingService={logger as ILoggingService}>
      <DirectTuiSession
        backend={backend}
        settings={settings}
        root={root}
        remote={remote}
        initial={initial}
        unconfiguredSessionId={unconfiguredSessionId}
        connection={connection}
        retainedSnapshot={retained}
        onConnectionChange={(next, nextRetained) => {
          setRetained(nextRetained);
          setConnection(next);
        }}
        bridge={bridge}
        restart={restart}
        onExit={onExit}
        logger={logger}
      />
    </TuiServicesProvider>
  );
}

function ProviderBanner({
  settingsService,
  backend,
  onHeightChange,
}: {
  readonly settingsService: ISettingsService;
  readonly backend: TuiBackend;
  readonly onHeightChange: (height: number) => void;
}): React.ReactElement {
  const selection = useSetting(settingsService, 'agent.modelSelection');
  const providerLabel =
    backend.providerLabel?.(selection.provider) || getProvider(selection.provider)?.label || selection.provider;
  return <Banner settingsService={settingsService} providerLabel={providerLabel} onHeightChange={onHeightChange} />;
}

function DirectTuiSession({
  unconfiguredSessionId,
  backend,
  settings,
  root,
  remote,
  initial,
  connection,
  retainedSnapshot,
  onConnectionChange,
  bridge,
  restart,
  onExit,
  logger,
}: {
  readonly backend: TuiBackend;
  readonly unconfiguredSessionId?: string;
  readonly settings: ISettingsService;
  readonly root: string;
  readonly remote: DirectSessionTarget['restart'];
  readonly initial: DirectConnection;
  readonly connection: ActiveConnection;
  readonly retainedSnapshot?: WireSnapshot;
  readonly onConnectionChange: (next: ActiveConnection, retained?: WireSnapshot) => void;
  readonly bridge: DirectControlBridge;
  readonly restart: (plan: DirectRestartPlan) => void;
  readonly onExit: (snapshot: WireSnapshot) => void;
  readonly logger: LoggingService;
}): React.ReactElement {
  const [headerHeight, setHeaderHeight] = useState(4);
  // Holds what this client has folded, for the commands that read it.
  const latest = useRef(initial.snapshot);
  // Approval notifications wait one macrotask (see onLiveEvent); this lets a same-burst close cancel one.
  const pendingNotices = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const reconnecting = useRef(false);
  const displayMode = useSetting(settings, 'ui.displayMode') ?? 'concise';
  const notifier = useTerminalFocusNotifier({ stdout });
  const handleConnectionLost = useCallback(
    (_reason: string, info?: { readonly terminal?: boolean }) => {
      if (info?.terminal || !backend.reconnectSession || reconnecting.current) return;
      reconnecting.current = true;
      const snap = latest.current;
      void backend
        .reconnectSession(snap.sessionId, snap)
        .then((next) => {
          if (next.snapshot) latest.current = next.snapshot;
          onConnectionChange(next, next.snapshot ? undefined : snap);
        })
        .catch(() => {
          // Leave the visible connection error from useClient in place when reconnect fails.
        })
        .finally(() => {
          reconnecting.current = false;
        });
    },
    [backend, onConnectionChange],
  );
  const integration: TuiIntegration = useMemo(
    () => ({
      menus: createDirectTuiMenus({
        backend,
        logger,
        root,
        unconfiguredSessionId,
        currentSessionId: () => latest.current.sessionId,
      }),
      async shell(sessionId, command) {
        if (remote) throw new Error('Direct shell commands are not available in SSH workspaces.');
        const currentSettings = backend.liveSettings(sessionId);
        if (!currentSettings) throw new Error('The attached session has no live settings.');
        const startedAt = Date.now();
        const result = await executeShellCommand(command, {
          cwd: root,
          timeout: currentSettings.get('shell.timeout') ?? undefined,
          maxBuffer: 1024 * 1024,
        });
        const formatted = await formatShellExecutionOutput({
          command,
          cwd: root,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          maxOutputLength: currentSettings.get('tools.maxOutputChars') ?? undefined,
          maxOutputLines: currentSettings.get('shell.maxOutputLines') ?? undefined,
          durationMs: Date.now() - startedAt,
        });
        return { command, output: formatted.text, exitCode: result.exitCode, timedOut: result.timedOut };
      },
      preferences(sessionId) {
        const current = backend.liveSettings(sessionId);
        if (!current) throw new Error('The attached session has no live settings.');
        return { historySize: current.get('ui.historySize'), pasteThreshold: current.get('ui.pasteThreshold') };
      },
      status(sessionId) {
        const current = backend.liveSettings(sessionId);
        if (!current) throw new Error('The attached session has no live settings.');
        const providerId = latest.current.model.provider;
        return {
          contextWindow: backend.contextWindow(latest.current.model) ?? undefined,
          effort: current.get('agent.reasoningEffort'),
          approval: current.get('shell.autoApproveMode'),
          provider: {
            id: providerId,
            label: backend.providerLabel?.(providerId) || getProvider(providerId)?.label || providerId,
          },
        };
      },
      ...createDirectTuiCommands({
        backend,
        root,
        bridge,
        remote,
        onMcpAuthorizationUrl: (url) => stderr.write(`MCP authorization: ${url}\n`),
        restart,
        latest: () => latest.current,
        publish(next) {
          latest.current = next.snapshot;
          onConnectionChange(next);
        },
      }),
      disableClientNotificationDrain: backend.mode === 'daemon',
      onConnectionLost: backend.reconnectSession ? handleConnectionLost : undefined,
    }),
    [backend, root, remote, bridge, restart, logger, onConnectionChange, unconfiguredSessionId, handleConnectionLost],
  );
  return (
    <Tui
      connection={connection}
      retainedSnapshot={retainedSnapshot}
      header={
        <Box paddingLeft={2}>
          <ProviderBanner
            key={`header:${connection.sessionId}`}
            settingsService={settings}
            backend={backend}
            onHeightChange={setHeaderHeight}
          />
        </Box>
      }
      headerHeight={headerHeight}
      redrawKey={displayMode}
      showReasoning={displayMode === 'standard'}
      integration={integration}
      onLiveEvent={(event) => {
        if (event.sessionId !== connection.sessionId) return;
        // An approval opens only once a person must decide: the session reviews first and never
        // publishes a request it approves itself (src/session/approval/approval-arbiter.ts).
        // A person who answers during the review (`n`) opens and closes the request together; the
        // close arrives in the same delivery burst, so wait one macrotask before notifying.
        if (event.type === 'interaction_opened' && event.payload.interaction.kind === 'approval') {
          const id = event.payload.interaction.requestId;
          pendingNotices.current.set(
            id,
            setTimeout(() => {
              pendingNotices.current.delete(id);
              notifier.approvalNeeded();
            }, 0),
          );
        }
        if (event.type === 'interaction_resolved') {
          clearTimeout(pendingNotices.current.get(event.payload.requestId));
          pendingNotices.current.delete(event.payload.requestId);
        }
        if (event.type === 'turn_ended' && event.payload.outcome === 'completed') notifier.turnComplete();
      }}
      onSnapshot={(snapshot) => {
        latest.current = snapshot;
      }}
      onExit={() => onExit(latest.current)}
    />
  );
}

type Restart = { plan?: DirectRestartPlan };

async function renderMountedTui(options: {
  readonly backend: TuiBackend;
  readonly root: string;
  readonly remote: DirectSessionTarget['restart'];
  readonly initial: DirectConnection;
  readonly unconfiguredSessionId?: string;
  readonly bridge: DirectControlBridge;
  readonly pending: Restart;
  readonly background: TerminalBackground;
  readonly logger: LoggingService;
  readonly controlSocket?: InteractiveRequest['controlSocket'];
  readonly getExitCode: () => number;
  readonly setUnmount: (fn: (() => void) | null) => void;
}): Promise<number> {
  const { backend, root, remote, initial, unconfiguredSessionId, bridge, pending, background, logger, controlSocket } =
    options;
  if (!(stdin.isTTY && stdout.isTTY)) {
    stderr.write(`${INTERACTIVE_TERMINAL_REQUIRED}\n`);
    return 1;
  }
  const detectedBackground = await background;
  if (options.getExitCode() !== 0) return options.getExitCode();
  if (controlSocket) stderr.write(`${await bridge.attachAtStartup(initial.sessionId, controlSocket)}\n`);
  if (options.getExitCode() !== 0) return options.getExitCode();

  let exitedSnapshot: WireSnapshot | undefined;
  const instance = render(
    (
      <SettingsThemeProvider settingsService={backend.persistentSettings} detectedBackground={detectedBackground}>
        <SettingsSkinProvider settingsService={backend.persistentSettings}>
          <DirectTui
            backend={backend}
            root={root}
            remote={remote}
            initial={initial}
            unconfiguredSessionId={unconfiguredSessionId}
            logger={logger}
            bridge={bridge}
            restart={(plan) => {
              // Node's native exec failure can abort rather than throw. Publish
              // recovery before cleanup as well, while this terminal still exists.
              stderr.write(`Restart recovery command: ${plan.manualCommand}\n`);
              pending.plan = plan;
            }}
            onExit={(snapshot) => {
              exitedSnapshot = snapshot;
              instance.unmount();
            }}
          />
        </SettingsSkinProvider>
      </SettingsThemeProvider>
    ) as ReactNode,
    getInkRenderOptions(),
  );
  options.setUnmount(() => instance.unmount());
  await instance.waitUntilExit();
  printUsage(exitedSnapshot); // legacy cli.tsx printUsageOnce, before the resume hint (restarts too)
  if (
    !pending.plan &&
    options.getExitCode() === 0 &&
    exitedSnapshot?.messages.some((message) => message.role !== 'system')
  ) {
    // Legacy's getResumeCommand: the `term2` command, arguments unquoted.
    const args = ['term2'];
    if (remote) {
      args.push('--ssh', remote.target, '--remote-dir', remote.directory);
      if (remote.port && remote.port !== 22) args.push('--ssh-port', String(remote.port));
    }
    args.push('--resume', displaySessionId(exitedSnapshot.sessionId));
    stdout.write(
      `\nSession: ${displaySessionId(exitedSnapshot.sessionId)}\nTo resume this conversation: ${args.join(' ')}\n`,
    );
  }
  return options.getExitCode();
}

async function runTui(
  request: InteractiveRequest,
  target: DirectSessionTarget,
  pending: Restart,
  { background, programStatus }: TerminalProbe,
  mcp?: DirectMcp,
): Promise<number> {
  const { conversationsDir, selection, resumeId, fork, profileExplicit, controlSocket } = request;
  const { settings } = selection;
  const { root } = target;
  const bridge = createDirectControlBridge(() => ({ app, root }));
  const app = await createDirectApplication({
    conversationsDir,
    selection,
    ...(profileExplicit !== undefined ? { profileExplicit } : {}),
    surface: (sessionId) => ({
      interactive: true,
      sessionBrowser: true,
      ...bridge.outbound(sessionId),
      ...target.surface,
      mcp,
    }),
    mcpCatalog: mcp ?? null,
    // The person at this terminal named the model, as with `-m` today.
    authorizeModel: () => undefined,
    authority: target.authority,
    ...(target.binding ? { sessionBinding: target.binding } : {}),
    hooks: { root: fs.realpathSync(process.cwd()), mode: 'interactive', programStatus },
  });
  const backend = createInProcessTuiBackend({ app, persistentSettings: settings, logger: selection.logger, mcp });
  let unmount: (() => void) | null = null;
  let exitCode = 0;
  // Raw Ctrl+C is owned by Tui; outside signals unwind through the same cleanup.
  const onSignal = (signal: NodeJS.Signals): void => {
    exitCode = signal === 'SIGINT' ? 130 : 143;
    if (unmount) unmount();
    // Setup unwinds through the same app/MCP cleanup once its current await ends.
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    const sessionId = resumeId !== undefined && fork ? await app.forkSession(resumeId) : resumeId;
    if (sessionId !== resumeId)
      stderr.write(`Forked conversation ${displaySessionId(resumeId!)} → ${displaySessionId(sessionId!)}\n`);
    if (sessionId !== undefined && request.resumeConfiguration)
      await app.applyLaunchConfiguration(sessionId, request.resumeConfiguration);
    const initial =
      sessionId === undefined
        ? await app.host.createSession(app.principal, target.grant)
        : await app.host.connect(app.principal, sessionId);
    if (sessionId !== undefined) stdout.write(`Resumed conversation: ${displaySessionId(initial.sessionId)}\n`);
    if (request.goal) await app.setGoal(initial.sessionId, request.goal, 'launcher');

    return await renderMountedTui({
      backend,
      root,
      remote: target.restart,
      initial,
      unconfiguredSessionId:
        sessionId === undefined && settings.getSource?.('agent.modelSelection') === 'default'
          ? initial.sessionId
          : undefined,
      bridge,
      pending,
      background,
      logger: selection.logger,
      controlSocket,
      getExitCode: () => exitCode,
      setUnmount: (fn) => {
        unmount = fn;
      },
    });
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    try {
      await bridge.close();
    } finally {
      await backend.close();
    }
  }
}

/** Runs after `prepareInteractiveTerminal` confirmed the start and sent the terminal probe. */
export async function launchTui(request: InteractiveRequest, terminal: TerminalProbe): Promise<number> {
  const pending: Restart = {};
  const useDaemon =
    process.env['TERM2_DAEMON_MODE'] === '1' &&
    process.env['TERM2_IN_PROCESS'] !== '1' &&
    !request.ssh &&
    !request.controlSocket;
  let exitCode: number;
  try {
    if (useDaemon) {
      exitCode = await runDaemonTuiSession(request, (mounted) =>
        renderMountedTui({
          ...mounted,
          remote: undefined,
          pending,
          background: terminal.background,
          logger: request.selection.logger,
        }),
      );
    } else {
      const target = await openDirectSessionTarget(request.ssh, request.lite, new AbortController().signal);
      let mcp: DirectMcp | undefined;
      try {
        // Terminal refusal must not start MCP subprocesses or authorization flows.
        if (stdin.isTTY && stdout.isTTY) {
          mcp = await openDirectApplicationMcp({
            target,
            conversationsDir: request.conversationsDir,
            interactive: true,
            onNotice: (message) => stderr.write(`MCP: ${message}\n`),
          });
        }
        exitCode = await runTui(request, target, pending, terminal, mcp);
      } finally {
        try {
          await mcp?.close();
        } finally {
          await target.close();
        }
      }
    }
    if (pending.plan) performRestart(pending.plan, request.conversationsDir, { skipWriterLockCheck: useDaemon });
  } catch (error) {
    if (!pending.plan) throw error;
    // Legacy cli.tsx: a failed restart cleanup never attempts the replacement.
    stderr.write(
      `Restart cleanup failed; no replacement attempted: ${error instanceof Error ? error.message : String(error)}\n` +
        `Restart recovery command: ${pending.plan.manualCommand}\n`,
    );
    return 1;
  }
  return exitCode;
}
