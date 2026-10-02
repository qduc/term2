import { describe, expect, it } from 'vitest';
import { THEMES, THEME_NAMES, type ThemeTokens } from './palettes.js';

/** WCAG 2.x relative luminance and contrast ratio. */
const channel = (value: number) => {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

/**
 * Policy: body text and status colours must stay readable (4.5:1) on every
 * background the palette claims to support; tertiary hints may be dimmer (3:1).
 * The light-terminal bug this guards against — user text with no explicit
 * foreground on a dark band — measured 1.5:1.
 */
const BODY_MIN = 4.5;
const HINT_MIN = 3;

const BODY_KEYS = [
  'text',
  'textMuted',
  'toolOutput',
  'accent',
  'accentAlt',
  'success',
  'warning',
  'danger',
  'dangerSoft',
] as const satisfies readonly (keyof ThemeTokens)[];
const HINT_KEYS = ['textSubtle', 'reasoning'] as const satisfies readonly (keyof ThemeTokens)[];

const colorThemes = THEME_NAMES.filter((name) => THEMES[name].supportedBackgrounds.length > 0);

describe('theme palettes', () => {
  it('registers every theme under its own name', () => {
    for (const name of THEME_NAMES) {
      expect(THEMES[name].name).toBe(name);
    }
  });

  it('gives every theme the same set of tokens', () => {
    const expected = Object.keys(THEMES.dark).sort();
    for (const name of THEME_NAMES) {
      expect(Object.keys(THEMES[name]).sort()).toEqual(expected);
    }
  });

  it('uses only #rrggbb colours, so palettes cannot depend on the user terminal palette', () => {
    const hex = /^#[0-9a-f]{6}$/i;
    for (const name of colorThemes) {
      const t = THEMES[name];
      const values = [
        ...BODY_KEYS.map((k) => t[k]),
        ...HINT_KEYS.map((k) => t[k]),
        t.border,
        t.borderActive,
        t.codeBackground,
        t.userBackground,
        t.userText,
        t.modeBadgeForeground,
        ...Object.values(t.modeBadge),
        ...Object.values(t.toolStatus),
      ];
      for (const value of values) {
        expect(value, `${name}`).toMatch(hex);
      }
    }
  });

  it('mono defines no colours at all', () => {
    const t = THEMES.mono;
    expect(t.supportedBackgrounds).toEqual([]);
    for (const value of [...BODY_KEYS.map((k) => t[k]), ...HINT_KEYS.map((k) => t[k]), t.userBackground, t.userText]) {
      expect(value).toBeUndefined();
    }
    for (const value of [...Object.values(t.modeBadge), ...Object.values(t.toolStatus)]) {
      expect(value).toBeUndefined();
    }
  });

  describe.each(colorThemes)('%s', (name) => {
    const t = THEMES[name];

    it.each(t.supportedBackgrounds)('body colours reach %s:1 on %s', (background) => {
      for (const key of BODY_KEYS) {
        const ratio = contrast(t[key] as string, background);
        expect(ratio, `${name}.${key} on ${background}`).toBeGreaterThanOrEqual(BODY_MIN);
      }
    });

    it.each(t.supportedBackgrounds)('hint colours reach 3:1 on %s', (background) => {
      for (const key of HINT_KEYS) {
        const ratio = contrast(t[key] as string, background);
        expect(ratio, `${name}.${key} on ${background}`).toBeGreaterThanOrEqual(HINT_MIN);
      }
    });

    it('keeps user message text readable on the user message band', () => {
      expect(contrast(t.userText as string, t.userBackground as string)).toBeGreaterThanOrEqual(BODY_MIN);
    });

    it('keeps the accent readable on inline code backgrounds', () => {
      expect(contrast(t.accent as string, t.codeBackground as string)).toBeGreaterThanOrEqual(3);
    });

    it('keeps badge text readable on every mode badge', () => {
      for (const [mode, background] of Object.entries(t.modeBadge)) {
        const ratio = contrast(t.modeBadgeForeground as string, background as string);
        expect(ratio, `${name} badge ${mode}`).toBeGreaterThanOrEqual(BODY_MIN);
      }
    });
  });
});
