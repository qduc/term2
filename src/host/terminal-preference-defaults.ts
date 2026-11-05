import { DEFAULT_SETTINGS } from '../config/settings/settings-schema.js';

/** Canonical defaults for terminal clients without effective session preferences. */
export function terminalPreferenceDefaults(): {
  readonly historySize: number;
  readonly pasteThreshold: number | undefined;
} {
  return {
    historySize: DEFAULT_SETTINGS.ui.historySize,
    pasteThreshold: DEFAULT_SETTINGS.ui.pasteThreshold,
  };
}
