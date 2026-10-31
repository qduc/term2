/** The interactive terminal client on the direct host. The app owns the connection and replaces it across sessions. */
import fs from 'node:fs';
import { homedir } from 'node:os';
import { stderr, stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import React, { useMemo, useState, type ReactNode } from 'react';
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
import { createLocalAuthority, localGrant } from './direct-application-workspaces.js';
import { attachControlSocket, type DirectControlAttachment } from './direct-launch-control.js';
import { createDirectTuiCommands } from './direct-launch-tui-commands.js';
import type { DirectLaunchRequest } from './direct-launch-types.js';

type InteractiveRequest = Extract<DirectLaunchRequest, { readonly kind: 'interactive' }>;

async function confirmHomeStart(lite: boolean): Promise<boolean> {
  const needed = shouldWarnOnHomeDirectoryStart({ cwd: process.cwd(), homeDir: homedir(), isNonLiteStart: !lite });
  if (!needed) return true;
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
  initial,
  control,
  onExit,
}: {
  readonly app: DirectApplication;
  readonly root: string;
  readonly initial: DirectConnection;
  readonly control: DirectControlAttachment | null;
  readonly onExit: () => void;
}): React.ReactElement {
  // Replacement attaches fresh in this process, so an ordinary snapshot always applies and no cursor is retained.
  const [connection, setConnection] = useState(initial);
  const integration: TuiIntegration = useMemo(
    () =>
      createDirectTuiCommands({
        app,
        root,
        async replace(next) {
          setConnection(next);
          await control?.rebind(next.sessionId);
        },
      }),
    [app, root, control],
  );
  return <Tui connection={connection} integration={integration} onExit={onExit} />;
}

export async function launchTui(request: InteractiveRequest): Promise<number> {
  if (!(await confirmHomeStart(request.lite))) return 1;

  const { conversationsDir, selection, resumeId, profileExplicit, controlSocket } = request;
  const { settings } = selection;
  const root = fs.realpathSync(process.cwd());
  const app = createDirectApplication({
    conversationsDir,
    selection,
    ...(profileExplicit !== undefined ? { profileExplicit } : {}),
    surface: { interactive: true },
    authority: createLocalAuthority((candidate) => candidate === root),
  });
  let control: DirectControlAttachment | null = null;
  let unmount: (() => void) | null = null;
  let exitCode = 0;
  // Ink leaves Ctrl+C to the composer, so an outside signal is the only other way out.
  const onSignal = (signal: NodeJS.Signals): void => {
    exitCode = signal === 'SIGINT' ? 130 : 143;
    if (unmount) unmount();
    else process.exit(exitCode);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    const initial =
      resumeId === undefined
        ? await app.host.createSession(app.principal, localGrant(root))
        : await app.host.connect(app.principal, resumeId);

    // Ask before Ink takes stdin: the terminal's reply arrives as input.
    const detectedBackground = shouldDetectBackground(settings.get('ui.theme'), process.env)
      ? await detectTerminalBackground({ stdin, stdout })
      : undefined;

    if (controlSocket) {
      const attached = await attachControlSocket(app, { conversationsDir, root, sessionId: initial.sessionId, ...controlSocket });
      control = attached.attachment;
      stderr.write(`${attached.notice}\n`);
    }

    const instance = render(
      (
        <SettingsThemeProvider settingsService={settings} detectedBackground={detectedBackground}>
          <SettingsSkinProvider settingsService={settings}>
            <DirectTui app={app} root={root} initial={initial} control={control} onExit={() => instance.unmount()} />
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
    await control?.close();
    await app.close();
  }
}
