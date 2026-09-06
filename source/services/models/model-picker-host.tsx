import React from 'react';
import { render } from 'ink';
import StandaloneModelPickerApp, {
  type StandaloneModelPickerOutcome,
} from '../../components/menu/StandaloneModelPickerApp.js';
import type { ILoggingService } from '../service-interfaces.js';
import type { SettingsService } from '../settings/settings-service.js';
import type { ModelFetcher } from './model-catalog-session.js';

export type ModelPickerHostResult = StandaloneModelPickerOutcome;

type TtyStreamLike = { isTTY?: boolean };

export type ModelPickerHostStreams = {
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  stderr?: NodeJS.WriteStream;
};

/**
 * `--model` resolves before the interactive app renders (see cli.tsx), so
 * this is the only place in the boot sequence that can ever need to mount an
 * Ink tree ahead of `App`. This guard, and `isModelPickerEligible` below, are
 * the single source of truth for "may this process ever mount the picker" —
 * cli.tsx calls them instead of re-deriving the TTY/mode checks inline, so
 * the "never mount Ink for a non-interactive run" rule lives in one tested
 * place.
 */
export function isModelPickerHostSupported(streams: { stdin?: TtyStreamLike; stdout?: TtyStreamLike } = {}): boolean {
  const stdin = streams.stdin ?? process.stdin;
  const stdout = streams.stdout ?? process.stdout;
  return Boolean(stdin.isTTY) && Boolean(stdout.isTTY);
}

/**
 * Full eligibility for offering the interactive picker anywhere in the
 * `--model` flow (ambiguous match, no match, or no value): a real TTY on
 * both ends, no positional prompt (non-interactive run), no `--json`, and no
 * isolated-harness marker. Every one of these must independently block the
 * picker; a session that fails any of them keeps today's non-interactive
 * behavior (readline disambiguation, hard errors, or silent passthrough)
 * untouched.
 */
export function isModelPickerEligible(opts: {
  stdin?: TtyStreamLike;
  stdout?: TtyStreamLike;
  hasPositionalPrompt: boolean;
  json: boolean;
  harnessIdle: boolean;
}): boolean {
  return (
    isModelPickerHostSupported({ stdin: opts.stdin, stdout: opts.stdout }) &&
    !opts.hasPositionalPrompt &&
    !opts.json &&
    !opts.harnessIdle
  );
}

export type ModelPickerHostOptions = ModelPickerHostStreams & {
  settingsService: SettingsService;
  loggingService: ILoggingService;
  modelFetcher?: ModelFetcher;
  /** Filter query the menu opens with (e.g. the pattern typed after --model). */
  initialQuery?: string;
  /** Provider tab the menu opens on (e.g. where the top-ranked match lives). */
  initialProvider?: string;
  /** When set (an explicit --provider), the tab is locked to this provider. */
  lockProvider?: string;
  /** One-line explanations shown above the menu (e.g. "No models match ..."). */
  bannerLines?: string[];
};

/**
 * Mounts the standalone model picker, waits for a selection or cancellation,
 * and unmounts before returning — a short-lived Ink render ahead of the main
 * app's own `render()` call in cli.tsx. Never mounts without a real TTY on
 * both ends (`isModelPickerHostSupported`), returning `cancelled` instead.
 *
 * Teardown is Ink's own normal app-exit path: `StandaloneModelPickerApp`
 * calls `useApp().exit()` exactly once (via `onDone`), which runs Ink's
 * `unmount()` synchronously (raw mode, the resize listener, and the cursor
 * are restored by Ink itself) before `waitUntilExit()` resolves. Ink keys its
 * one live renderer per stdout object and deletes that entry on unmount, so
 * a later `render()` call against the same stdout (the main app's) creates a
 * fresh instance rather than colliding with this one.
 */
export async function runModelPickerHost(options: ModelPickerHostOptions): Promise<ModelPickerHostResult> {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;

  if (!isModelPickerHostSupported({ stdin, stdout })) {
    return { status: 'cancelled' };
  }

  let outcome: StandaloneModelPickerOutcome = { status: 'cancelled' };

  const { waitUntilExit } = render(
    <StandaloneModelPickerApp
      settingsService={options.settingsService}
      loggingService={options.loggingService}
      modelFetcher={options.modelFetcher}
      initialQuery={options.initialQuery}
      initialProvider={options.initialProvider}
      lockProvider={options.lockProvider}
      bannerLines={options.bannerLines}
      onDone={(result) => {
        outcome = result;
      }}
    />,
    {
      stdin,
      stdout,
      stderr,
      // The picker never writes to `console` itself, and nothing else logs
      // while it is mounted, so Ink's own console patch/restore machinery
      // (there to keep stray console output from corrupting the frame) has
      // nothing to do here. Skipping it also sidesteps a real fragility:
      // Ink's patch assumes a constructible `console.Console`, which some
      // test/runtime consoles do not provide.
      patchConsole: false,
    },
  );

  await waitUntilExit();
  return outcome;
}
