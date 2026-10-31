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
  onExit,
}: {
  readonly app: DirectApplication;
  readonly root: string;
  readonly initial: DirectConnection;
  readonly onExit: () => void;
}): React.ReactElement {
  const [connection, setConnection] = useState(initial);
  const integration: TuiIntegration = useMemo(
    () => createDirectTuiCommands({ app, root, replace: setConnection }),
    [app, root],
  );
  return <Tui connection={connection} integration={integration} onExit={onExit} />;
}

export async function launchTui(request: InteractiveRequest): Promise<number> {
  if (!(await confirmHomeStart(request.lite))) return 1;

  const { conversationsDir, selection, resumeId, profileExplicit } = request;
  const { settings } = selection;
  const root = fs.realpathSync(process.cwd());
  const app = createDirectApplication({
    conversationsDir,
    selection,
    ...(profileExplicit !== undefined ? { profileExplicit } : {}),
    surface: { interactive: true },
    authority: createLocalAuthority((candidate) => candidate === root),
  });
  try {
    const initial =
      resumeId === undefined
        ? await app.host.createSession(app.principal, localGrant(root))
        : await app.host.connect(app.principal, resumeId);

    // Ask before Ink takes stdin: the terminal's reply arrives as input.
    const detectedBackground = shouldDetectBackground(settings.get('ui.theme'), process.env)
      ? await detectTerminalBackground({ stdin, stdout })
      : undefined;

    const instance = render(
      (
        <SettingsThemeProvider settingsService={settings} detectedBackground={detectedBackground}>
          <SettingsSkinProvider settingsService={settings}>
            <DirectTui app={app} root={root} initial={initial} onExit={() => instance.unmount()} />
          </SettingsSkinProvider>
        </SettingsThemeProvider>
      ) as ReactNode,
      getInkRenderOptions(),
    );
    await instance.waitUntilExit();
    return 0;
  } finally {
    await app.close();
  }
}
