/**
 * What the interactive launcher asks of the terminal before the TUI loads. Nothing
 * else reads stdin until Ink renders, so these run first and in this order: the
 * home-directory confirmation (a line prompt), then the background colour query,
 * whose reply is read just before rendering.
 *
 * Sending the query before the TUI's modules initialize lets its round trip, or
 * the timeout of a terminal that never answers, overlap that work and the rest of
 * startup instead of following it.
 */
import { homedir } from 'node:os';
import { stderr, stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { detectTerminalBackground } from '../clients/tui/presentation/theme/detect-terminal-background.js';
import { shouldDetectBackground, type BackgroundMode } from '../clients/tui/presentation/theme/resolve-theme.js';
import {
  confirmHomeDirectoryStart,
  HOME_DIRECTORY_START_WARNING,
  shouldWarnOnHomeDirectoryStart,
} from '../shared/utils/home-directory-start-guard.js';
import type { DirectLaunchRequest } from './launch-types.js';

type InteractiveRequest = Extract<DirectLaunchRequest, { readonly kind: 'interactive' }>;

/** The terminal's answer to the background query, still arriving. */
export type TerminalBackground = Promise<BackgroundMode | undefined>;

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

/** Confirms the start and sends the background query; `undefined` when the user declined to start. */
export async function prepareInteractiveTerminal(
  request: InteractiveRequest,
): Promise<{ readonly background: TerminalBackground } | undefined> {
  if (!(await confirmHomeStart(request))) return undefined;
  return {
    background: shouldDetectBackground(request.selection.settings.get('ui.theme'), process.env)
      ? detectTerminalBackground({ stdin, stdout })
      : Promise.resolve(undefined),
  };
}
