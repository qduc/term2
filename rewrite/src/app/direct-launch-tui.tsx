/** The interactive terminal client on the direct host. The app owns the connection and replaces it across sessions. */
import fs from 'node:fs';
import { homedir } from 'node:os';
import { stderr, stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import React, { useMemo, useRef, useState, type ReactNode } from 'react';
import { render } from 'ink';
import { SettingsSkinProvider } from '../../../source/skins/SkinContext.js';
import { detectTerminalBackground } from '../../../source/theme/detect-terminal-background.js';
import { shouldDetectBackground } from '../../../source/theme/resolve-theme.js';
import { SettingsThemeProvider } from '../../../source/theme/ThemeContext.js';
import { getInkRenderOptions } from '../../../source/utils/ink-render-options.js';
import {
  confirmHomeDirectoryStart,
  HOME_DIRECTORY_START_WARNING,
  shouldWarnOnHomeDirectoryStart,
} from '../../../source/utils/home-directory-start-guard.js';
import { Tui, type TuiIntegration } from '../clients/tui/index.js';
import type { DirectConnection } from '../host/in-process-direct-types.js';
import { createDirectApplication, type DirectApplication } from './direct-application.js';
import { openDirectSessionTarget, type DirectSessionTarget } from './direct-application-target.js';
import { createDirectControlBridge, type DirectControlBridge } from './direct-launch-control.js';
import { createDirectTuiCommands } from './direct-launch-tui-commands.js';
import { performRestart, type DirectRestartPlan } from './direct-launch-tui-restart.js';
import type { DirectLaunchRequest } from './direct-launch-types.js';
import { openDirectApplicationMcp } from './direct-application-mcp.js';
import type { DirectMcp } from './direct-mcp.js';

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
  root,
  remote,
  mcp,
  initial,
  bridge,
  restart,
  onExit,
}: {
  readonly app: DirectApplication;
  readonly root: string;
  readonly remote: DirectSessionTarget['restart'];
  readonly mcp?: DirectMcp;
  readonly initial: DirectConnection;
  readonly bridge: DirectControlBridge;
  readonly restart: (plan: DirectRestartPlan) => void;
  readonly onExit: () => void;
}): React.ReactElement {
  const [connection, setConnection] = useState(initial);
  // Holds what this client has folded, for the commands that read it.
  const latest = useRef(initial.snapshot);
  const integration: TuiIntegration = useMemo(
    () =>
      createDirectTuiCommands({
        app,
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
    [app, root, remote, mcp, bridge, restart],
  );
  return (
    <Tui
      connection={connection}
      integration={integration}
      onSnapshot={(snapshot) => {
        latest.current = snapshot;
      }}
      onExit={onExit}
    />
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
  // Ink leaves Ctrl+C to the composer, so an outside signal is the only other way out.
  const onSignal = (signal: NodeJS.Signals): void => {
    exitCode = signal === 'SIGINT' ? 130 : 143;
    if (unmount) unmount();
    // Setup unwinds through the same app/MCP cleanup once its current await ends.
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    const sessionId = resumeId !== undefined && fork ? await app.forkSession(resumeId) : resumeId;
    if (sessionId !== resumeId) stderr.write(`Forked conversation ${resumeId} → ${sessionId}\n`);
    const initial =
      sessionId === undefined
        ? await app.host.createSession(app.principal, target.grant)
        : await app.host.connect(app.principal, sessionId);
    if (request.goal) await app.setGoal(initial.sessionId, request.goal, 'launcher');

    // Ask before Ink takes stdin: the terminal's reply arrives as input.
    const detectedBackground = shouldDetectBackground(settings.get('ui.theme'), process.env)
      ? await detectTerminalBackground({ stdin, stdout })
      : undefined;

    if (exitCode !== 0) return exitCode;
    if (controlSocket) stderr.write(`${await bridge.attachAtStartup(initial.sessionId, controlSocket)}\n`);
    if (exitCode !== 0) return exitCode;

    const instance = render(
      (
        <SettingsThemeProvider settingsService={settings} detectedBackground={detectedBackground}>
          <SettingsSkinProvider settingsService={settings}>
            <DirectTui
              app={app}
              root={root}
              remote={target.restart}
              mcp={mcp}
              initial={initial}
              bridge={bridge}
              restart={(plan) => {
                pending.plan = plan;
              }}
              onExit={() => instance.unmount()}
            />
          </SettingsSkinProvider>
        </SettingsThemeProvider>
      ) as ReactNode,
      getInkRenderOptions(),
    );
    unmount = () => instance.unmount();
    await instance.waitUntilExit();
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
    mcp = await openDirectApplicationMcp({
      target,
      conversationsDir: request.conversationsDir,
      interactive: true,
      onNotice: (message) => stderr.write(`MCP: ${message}\n`),
    });
    exitCode = await runTui(request, target, pending, mcp);
  } finally {
    try {
      await mcp?.close();
    } finally {
      await target.close();
    }
  }
  if (pending.plan) performRestart(pending.plan);
  return exitCode;
}
