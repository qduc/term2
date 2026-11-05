import { THEME_NAMES, type ThemeName } from './palettes.js';

/** What `ui.theme` may hold: a concrete theme, or `auto` to pick one for the terminal. */
export type ThemeSetting = 'auto' | ThemeName;
export const THEME_SETTING_VALUES = ['auto', ...THEME_NAMES] as const;

export type BackgroundMode = 'dark' | 'light';
export type Rgb = { r: number; g: number; b: number };

export interface ResolveThemeContext {
  env: Readonly<Record<string, string | undefined>>;
  /** What the terminal itself reported (OSC 11), when it answered. */
  detectedBackground?: BackgroundMode;
}

/**
 * Picks the concrete theme for a `ui.theme` setting.
 *
 * An explicit theme always wins, including over `NO_COLOR`: that variable is a
 * default for software that has no user configuration, and the no-color.org
 * convention lets explicit user config override it.
 *
 * For `auto`, evidence is ordered by how much it can be trusted: no-colour
 * signals, then what the terminal actually reported, then the static
 * `COLORFGBG` hint some terminals export, then dark (the common case).
 */
export function resolveThemeName(setting: ThemeSetting, context: ResolveThemeContext): ThemeName {
  if (setting !== 'auto') {
    return setting;
  }
  const { env, detectedBackground } = context;
  if (colorIsOff(env)) {
    return 'mono';
  }
  const mode = detectedBackground ?? parseColorFgBg(env.COLORFGBG);
  return mode === 'light' ? 'light' : 'dark';
}

const colorIsOff = (env: ResolveThemeContext['env']): boolean => (env.NO_COLOR ?? '') !== '' || env.TERM === 'dumb';

/**
 * Whether startup should spend a round trip asking the terminal for its
 * background. Only `auto` can use the answer, and only while colour is on:
 * otherwise `resolveThemeName` ignores it, so asking would be pure cost.
 */
export function shouldDetectBackground(setting: ThemeSetting, env: ResolveThemeContext['env']): boolean {
  return setting === 'auto' && !colorIsOff(env);
}

/**
 * `COLORFGBG` is `fg;bg` or `fg;default;bg` using ANSI palette indices. Indices
 * 0-6 and 8 are dark; 7 and 9-15 are light. Anything else is unknown rather
 * than guessed.
 */
export function parseColorFgBg(value: string | undefined): BackgroundMode | undefined {
  if (!value) {
    return undefined;
  }
  const parts = value.split(';');
  if (parts.length < 2) {
    return undefined;
  }
  const last = parts[parts.length - 1];
  if (!/^\d+$/.test(last)) {
    return undefined;
  }
  const index = Number(last);
  if (index > 15) {
    return undefined;
  }
  return index === 7 || index >= 9 ? 'light' : 'dark';
}

const OSC11_REPLY =
  /\u001B\]11;rgba?:([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})(?:\/[0-9a-fA-F]{1,4})?(?:\u0007|\u001B\\)/;

/** Scales a 1-4 digit hex channel to 0-255. */
const scaleChannel = (digits: string): number => Math.round((parseInt(digits, 16) / (16 ** digits.length - 1)) * 255);

/** Parses a terminal's reply to an OSC 11 (background colour) query. */
export function parseOsc11Response(data: string): Rgb | undefined {
  const match = OSC11_REPLY.exec(data);
  if (!match) {
    return undefined;
  }
  return { r: scaleChannel(match[1]), g: scaleChannel(match[2]), b: scaleChannel(match[3]) };
}

/** Classifies by perceived luminance (Rec. 601), so saturated-but-dark colours stay dark. */
export function backgroundModeFromRgb({ r, g, b }: Rgb): BackgroundMode {
  return 0.299 * r + 0.587 * g + 0.114 * b > 128 ? 'light' : 'dark';
}
