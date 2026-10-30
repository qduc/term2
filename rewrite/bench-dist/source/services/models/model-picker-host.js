import React from 'react';
/**
 * `--model` resolves before the interactive app renders (see cli.tsx), so
 * this is the only place in the boot sequence that can ever need to mount an
 * Ink tree ahead of `App`. This guard, and `isModelPickerEligible` below, are
 * the single source of truth for "may this process ever mount the picker" —
 * cli.tsx calls them instead of re-deriving the TTY/mode checks inline, so
 * the "never mount Ink for a non-interactive run" rule lives in one tested
 * place.
 */
export function isModelPickerHostSupported(streams = {}) {
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
export function isModelPickerEligible(opts) {
    return (isModelPickerHostSupported({ stdin: opts.stdin, stdout: opts.stdout }) &&
        !opts.hasPositionalPrompt &&
        !opts.json &&
        !opts.harnessIdle);
}
/**
 * Mounts the standalone model picker, waits for a selection or cancellation,
 * and unmounts before returning — a short-lived Ink render ahead of the main
 * app's own `render()` call in cli.tsx. Never mounts without a real TTY on
 * both ends (`isModelPickerHostSupported`), returning `cancelled` instead.
 *
 * The host clears the transient picker frame before unmounting it (Ink's
 * normal unmount commits the final frame to scrollback). Unmount synchronously
 * restores raw mode, the resize listener, and the cursor before
 * `waitUntilExit()` resolves. Ink keys its
 * one live renderer per stdout object and deletes that entry on unmount, so
 * a later `render()` call against the same stdout (the main app's) creates a
 * fresh instance rather than colliding with this one.
 */
export async function runModelPickerHost(options) {
    const stdin = options.stdin ?? process.stdin;
    const stdout = options.stdout ?? process.stdout;
    const stderr = options.stderr ?? process.stderr;
    if (!isModelPickerHostSupported({ stdin, stdout })) {
        return { status: 'cancelled' };
    }
    // Eligibility checks also run for headless CLI prompts. Load the terminal
    // renderer only after the TTY guard, keeping Yoga initialization out of them.
    const [{ render }, { SettingsThemeProvider }, { SettingsSkinProvider }, { default: StandaloneModelPickerApp }] = await Promise.all([
        import('ink'),
        import('../../theme/ThemeContext.js'),
        import('../../skins/SkinContext.js'),
        import('../../components/menu/StandaloneModelPickerApp.js'),
    ]);
    let outcome = { status: 'cancelled' };
    let picker;
    picker = render(React.createElement(SettingsThemeProvider, { settingsService: options.settingsService },
        React.createElement(SettingsSkinProvider, { settingsService: options.settingsService },
            React.createElement(StandaloneModelPickerApp, { settingsService: options.settingsService, loggingService: options.loggingService, modelFetcher: options.modelFetcher, initialQuery: options.initialQuery, initialProvider: options.initialProvider, lockProvider: options.lockProvider, bannerLines: options.bannerLines, onDone: (result) => {
                    outcome = result;
                    picker.clear();
                    picker.unmount();
                } }))), {
        stdin,
        stdout,
        stderr,
        // Interactive by construction: the guard above already requires a real
        // TTY on both ends, which is what interactivity actually needs. Ink's
        // own default is `!is-in-ci && stdout.isTTY`, and CI detection wins
        // even over a TTY (see node_modules/ink/build/ink.js
        // `resolveInteractiveOption`). Left to that default, a run with `CI` set
        // renders no frame at all while the menu is up — it defers output and
        // writes only the final frame at unmount — so the picker the user is
        // choosing from never appears. Note this is not test-only: the same
        // shape (a PTY under a CI-marked environment) is why the provider
        // black-box harness deletes `CI` from its child env.
        interactive: true,
        // The picker never writes to `console` itself, and nothing else logs
        // while it is mounted, so Ink's own console patch/restore machinery
        // (there to keep stray console output from corrupting the frame) has
        // nothing to do here. Skipping it also sidesteps a real fragility:
        // Ink's patch assumes a constructible `console.Console`, which some
        // test/runtime consoles do not provide.
        patchConsole: false,
    });
    await picker.waitUntilExit();
    return outcome;
}
//# sourceMappingURL=model-picker-host.js.map