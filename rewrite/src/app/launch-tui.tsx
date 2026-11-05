import { executeShellCommand } from '../shared/utils/shell/execute-shell.js';
import { formatShellExecutionOutput } from '../shared/utils/shell/shell-output.js';
/** The interactive terminal client on the direct host. The app owns the connection and replaces it across sessions. */
import fs from 'node:fs';
import { homedir } from 'node:os';
import { stderr, stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { collectProviderModels } from '../model/models/model-listing.js';
import { resolveActiveProfile } from '../config/profiles/active-profile.js';
import React, { useMemo, useRef, useState, type ReactNode } from 'react';
import { Box, render } from 'ink';
import Banner from '../clients/components/layout/Banner.js';
import { SettingsSkinProvider, useSkin as useSourceSkin } from '../clients/skins/SkinContext.js';
import { SkinProvider as DirectSkinProvider } from '../clients/tui/presentation/skins/SkinContext.js';
import { getSkin as getDirectSkin } from '../clients/tui/presentation/skins/registry.js';
import { ThemeProvider as DirectThemeProvider } from '../clients/tui/presentation/theme/ThemeContext.js';
import { detectTerminalBackground } from '../clients/theme/detect-terminal-background.js';
import { shouldDetectBackground } from '../clients/theme/resolve-theme.js';
import { SettingsThemeProvider, useTheme as useSourceTheme } from '../clients/theme/ThemeContext.js';
import { getInkRenderOptions } from '../shared/utils/ink-render-options.js';
import { getProfileLabel } from '../config/profiles/labels.js';
import { getProvider } from '../model/providers/registry.js';
import type { WireSnapshot } from '../protocol/wire.js';
import { useTerminalFocusNotifier } from '../clients/hooks/use-terminal-focus-notifier.js';
import { useSetting } from '../clients/hooks/use-setting.js';
import type { LoggingService } from '../session/logging/logging-service.js';
import {
  confirmHomeDirectoryStart,
  HOME_DIRECTORY_START_WARNING,
  shouldWarnOnHomeDirectoryStart,
} from '../shared/utils/home-directory-start-guard.js';
import { Tui, type TuiIntegration } from '../clients/tui/index.js';
import type { DirectConnection } from '../host/in-process-direct-types.js';
import { createDirectApplication, type DirectApplication } from './application.js';
import { openDirectSessionTarget, type DirectSessionTarget } from './application-target.js';
import { createDirectControlBridge, type DirectControlBridge } from './launch-control.js';
import { createDirectTuiCommands } from './launch-tui-commands.js';
import { printUsage } from './usage-report.js';
import { createDirectTuiMenus } from './launch-tui-menus.js';
import { performRestart, type DirectRestartPlan } from './launch-tui-restart.js';
import type { DirectLaunchRequest } from './launch-types.js';
import type { ISettingsService } from '../shared/service-interfaces.js';
import { INTERACTIVE_TERMINAL_REQUIRED } from './launch.js';
import { openDirectApplicationMcp } from './application-mcp.js';
import type { DirectMcp } from './mcp.js';
import { displaySessionId } from '../protocol/session-id.js';

/** Footer profile labels by the selected profile setting (a profile id resolves to the same label). */
const profileLabels = new Map<unknown, string>();

type InteractiveRequest = Extract<DirectLaunchRequest, { readonly kind: 'interactive' }>;

async function confirmHomeStart({ lite, resumeId, ssh }: InteractiveRequest): Promise<boolean> {
  const isNonLiteStart = !lite && resumeId === undefined && !ssh;
  if (!shouldWarnOnHomeDirectoryStart({ cwd: process.cwd(), homeDir: homedir(), isNonLiteStart })) return true;
  const readline = createInterface({ input: stdin, output: stdout });
  try {
    const confirmed = await confirmHomeDirectoryStart(() => readline.question(HOME_DIRECTORY_START_WARNING));
    if (!confirmed) stderr.write('Cancelled.\n');
    return confirmed;
  } finally {
    readline.close();
  }
}

function DirectTui({
  app,
  persistentSettings,
  root,
  remote,
  mcp,
  initial,
  bridge,
  restart,
  onExit,
  logger,
}: {
  readonly app: DirectApplication;
  readonly persistentSettings: ISettingsService;
  readonly root: string;
  readonly remote: DirectSessionTarget['restart'];
  readonly mcp?: DirectMcp;
  readonly initial: DirectConnection;
  readonly bridge: DirectControlBridge;
  readonly restart: (plan: DirectRestartPlan) => void;
  readonly onExit: (snapshot: WireSnapshot) => void;
  readonly logger: LoggingService;
}): React.ReactElement {
  const [connection, setConnection] = useState(initial);
  const [headerHeight, setHeaderHeight] = useState(4);
  // Holds what this client has folded, for the commands that read it.
  const latest = useRef(initial.snapshot);
  // The notifier already owns terminal focus and all three preference gates.
  // Never use launch defaults: attached sessions own separate mutable settings.
  const settings = app.liveSettings(connection.sessionId);
  if (!settings) throw new Error('The attached session has no live settings.');
  const displayMode = useSetting(settings, 'ui.displayMode') ?? 'concise';
  const notifier = useTerminalFocusNotifier({ stdout, settingsService: settings, loggingService: logger });
  const integration: TuiIntegration = useMemo(
    () => ({
      menus: createDirectTuiMenus({ app, persistentSettings, logger, root }),
      async shell(sessionId, command) {
        if (remote) throw new Error('Direct shell commands are not available in SSH workspaces.');
        const settings = app.liveSettings(sessionId);
        if (!settings) throw new Error('The attached session has no live settings.');
        const startedAt = Date.now();
        const result = await executeShellCommand(command, {
          cwd: root,
          timeout: settings.get('shell.timeout') ?? undefined,
          maxBuffer: 1024 * 1024,
        });
        const formatted = await formatShellExecutionOutput({
          command,
          cwd: root,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          maxOutputLength: settings.get('shell.maxOutputChars') ?? undefined,
          maxOutputLines: settings.get('shell.maxOutputLines') ?? undefined,
          durationMs: Date.now() - startedAt,
        });
        return { command, output: formatted.text, exitCode: result.exitCode, timedOut: result.timedOut };
      },
      preferences(sessionId) {
        const current = app.liveSettings(sessionId);
        if (!current) throw new Error('The attached session has no live settings.');
        return { historySize: current.get('ui.historySize'), pasteThreshold: current.get('ui.pasteThreshold') };
      },
      status(sessionId) {
        const current = app.liveSettings(sessionId);
        if (!current) throw new Error('The attached session has no live settings.');
        // The footer asks on every render; resolving the profile each time cost about a tenth of a streaming frame.
        const selected = current.get('app.activeProfileId');
        let profile = profileLabels.get(selected);
        if (profile === undefined) {
          const label = getProfileLabel(resolveActiveProfile(current).identity.id);
          profileLabels.set(selected, (profile = label.charAt(0).toUpperCase() + label.slice(1)));
        }
        return {
          profile,
          contextWindow: app.contextWindow(latest.current.model) ?? undefined,
          effort: current.get('agent.reasoningEffort'),
          approval: current.get('shell.autoApproveMode'),
          provider: {
            id: latest.current.model.provider,
            label: getProvider(latest.current.model.provider)?.label || latest.current.model.provider,
          },
        };
      },
      ...createDirectTuiCommands({
        app,
        async modelCatalog(sessionId, provider) {
          const settingsService = app.liveSettings(sessionId);
          if (!settingsService) return { models: [], error: 'session settings unavailable' };
          const [group] = await collectProviderModels({ settingsService, loggingService: logger }, [provider]);
          return group ?? { models: [], error: 'provider catalog unavailable' };
        },
        root,
        bridge,
        remote,
        mcp,
        onMcpAuthorizationUrl: (url) => stderr.write(`MCP authorization: ${url}\n`),
        restart,
        latest: () => latest.current,
        publish(next) {
          latest.current = next.snapshot;
          setConnection(next);
        },
      }),
    }),
    [app, persistentSettings, root, remote, mcp, bridge, restart, logger],
  );
  const skin = useSourceSkin();
  const theme = useSourceTheme();
  return (
    <DirectThemeProvider theme={theme}>
      <DirectSkinProvider skin={getDirectSkin(skin.name)}>
        <Tui
          connection={connection}
          header={
            <Box paddingLeft={2}>
              <Banner
                key={`header:${connection.sessionId}`}
                settingsService={settings}
                onHeightChange={setHeaderHeight}
              />
            </Box>
          }
          headerHeight={headerHeight}
          redrawKey={displayMode}
          integration={integration}
          onLiveEvent={(event) => {
            if (event.sessionId !== connection.sessionId) return;
            if (event.type === 'interaction_opened' && event.payload.interaction.kind === 'approval')
              notifier.approvalNeeded();
            if (event.type === 'turn_ended' && event.payload.outcome === 'completed') notifier.turnComplete();
          }}
          onSnapshot={(snapshot) => {
            latest.current = snapshot;
          }}
          onExit={() => onExit(latest.current)}
        />
      </DirectSkinProvider>
    </DirectThemeProvider>
  );
}

type Restart = { plan?: DirectRestartPlan };

async function runTui(
  request: InteractiveRequest,
  target: DirectSessionTarget,
  pending: Restart,
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
      ...(mcp ? { mcp } : {}),
    }),
    ...(mcp ? { mcpCatalog: mcp } : {}),
    // The person at this terminal named the model, as with `-m` today.
    authorizeModel: () => undefined,
    authority: target.authority,
    ...(target.binding ? { sessionBinding: target.binding } : {}),
    hooks: { root: fs.realpathSync(process.cwd()), mode: 'interactive' },
  });
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
    const initial =
      sessionId === undefined
        ? await app.host.createSession(app.principal, target.grant)
        : await app.host.connect(app.principal, sessionId);
    // Read the opened session, not the launch defaults: resume may restore a different profile. Legacy (cli.tsx)
    // announces it before "Resumed conversation", and both before refusing a non-interactive terminal.
    const { profileId } = await app.sessionConfiguration(initial.sessionId);
    stderr.write(`Profile: ${profileId.replace(/^builtin:/, '')}\n`);
    if (sessionId !== undefined) stdout.write(`Resumed conversation: ${displaySessionId(initial.sessionId)}\n`);
    if (request.goal) await app.setGoal(initial.sessionId, request.goal, 'launcher');

    // An admitted CLI goal belongs to Session even when this process cannot render Ink.
    if (!(stdin.isTTY && stdout.isTTY)) {
      stderr.write(`${INTERACTIVE_TERMINAL_REQUIRED}\n`);
      return 1;
    }

    // Ask before Ink takes stdin: the terminal's reply arrives as input.
    const detectedBackground = shouldDetectBackground(settings.get('ui.theme'), process.env)
      ? await detectTerminalBackground({ stdin, stdout })
      : undefined;

    if (exitCode !== 0) return exitCode;
    if (controlSocket) stderr.write(`${await bridge.attachAtStartup(initial.sessionId, controlSocket)}\n`);
    if (exitCode !== 0) return exitCode;

    let exitedSnapshot: WireSnapshot | undefined;
    const instance = render(
      (
        <SettingsThemeProvider settingsService={settings} detectedBackground={detectedBackground}>
          <SettingsSkinProvider settingsService={settings}>
            <DirectTui
              app={app}
              persistentSettings={settings}
              root={root}
              remote={target.restart}
              mcp={mcp}
              initial={initial}
              logger={selection.logger}
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
    unmount = () => instance.unmount();
    await instance.waitUntilExit();
    printUsage(exitedSnapshot); // legacy cli.tsx printUsageOnce, before the resume hint (restarts too)
    if (!pending.plan && exitCode === 0 && exitedSnapshot?.messages.some((message) => message.role !== 'system')) {
      // Legacy's getResumeCommand: the `term2` command, arguments unquoted.
      const args = ['term2'];
      if (target.restart) {
        args.push('--ssh', target.restart.target, '--remote-dir', target.restart.directory);
        if (target.restart.port && target.restart.port !== 22) args.push('--ssh-port', String(target.restart.port));
      }
      args.push('--resume', displaySessionId(exitedSnapshot.sessionId));
      stdout.write(
        `\nSession: ${displaySessionId(exitedSnapshot.sessionId)}\nTo resume this conversation: ${args.join(' ')}\n`,
      );
    }
    return exitCode;
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    try {
      await bridge.close();
    } finally {
      await app.close();
    }
  }
}

export async function launchTui(request: InteractiveRequest): Promise<number> {
  if (!(await confirmHomeStart(request))) return 1;
  const target = await openDirectSessionTarget(request.ssh, request.lite, new AbortController().signal);
  const pending: Restart = {};
  let exitCode: number;
  let mcp: DirectMcp | undefined;
  try {
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
      exitCode = await runTui(request, target, pending, mcp);
    } finally {
      try {
        await mcp?.close();
      } finally {
        await target.close();
      }
    }
    if (pending.plan) performRestart(pending.plan, request.conversationsDir);
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
