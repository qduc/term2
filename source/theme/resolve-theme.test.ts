import { describe, expect, it } from 'vitest';
import {
  resolveThemeName,
  parseColorFgBg,
  parseOsc11Response,
  backgroundModeFromRgb,
  shouldDetectBackground,
} from './resolve-theme.js';

describe('resolveThemeName', () => {
  it('returns an explicit theme unchanged, even when the environment says otherwise', () => {
    expect(resolveThemeName('light', { env: { NO_COLOR: '1' }, detectedBackground: 'dark' })).toBe('light');
    expect(resolveThemeName('dark', { env: {}, detectedBackground: 'light' })).toBe('dark');
  });

  it('auto honours NO_COLOR with a mono theme', () => {
    expect(resolveThemeName('auto', { env: { NO_COLOR: '1' } })).toBe('mono');
  });

  it('auto ignores an empty NO_COLOR, per the no-color.org convention', () => {
    expect(resolveThemeName('auto', { env: { NO_COLOR: '' } })).toBe('dark');
  });

  it('auto treats TERM=dumb as mono', () => {
    expect(resolveThemeName('auto', { env: { TERM: 'dumb' } })).toBe('mono');
  });

  it('auto prefers the terminal-reported background over COLORFGBG', () => {
    expect(resolveThemeName('auto', { env: { COLORFGBG: '15;0' }, detectedBackground: 'light' })).toBe('light');
    expect(resolveThemeName('auto', { env: { COLORFGBG: '0;15' }, detectedBackground: 'dark' })).toBe('dark');
  });

  it('auto falls back to COLORFGBG when the terminal did not answer', () => {
    expect(resolveThemeName('auto', { env: { COLORFGBG: '0;15' } })).toBe('light');
    expect(resolveThemeName('auto', { env: { COLORFGBG: '15;0' } })).toBe('dark');
  });

  it('auto defaults to dark when nothing is known', () => {
    expect(resolveThemeName('auto', { env: {} })).toBe('dark');
  });
});

describe('shouldDetectBackground', () => {
  it('queries the terminal only for auto, where the answer can change the result', () => {
    expect(shouldDetectBackground('auto', {})).toBe(true);
    expect(shouldDetectBackground('dark', {})).toBe(false);
    expect(shouldDetectBackground('light', {})).toBe(false);
    expect(shouldDetectBackground('mono', {})).toBe(false);
  });

  it('does not query when colour is off anyway', () => {
    expect(shouldDetectBackground('auto', { NO_COLOR: '1' })).toBe(false);
    expect(shouldDetectBackground('auto', { TERM: 'dumb' })).toBe(false);
  });

  it('agrees with resolveThemeName: a skipped query never changes the resolved theme', () => {
    for (const env of [{ NO_COLOR: '1' }, { TERM: 'dumb' }]) {
      expect(shouldDetectBackground('auto', env)).toBe(false);
      expect(resolveThemeName('auto', { env, detectedBackground: 'light' })).toBe('mono');
    }
  });
});

describe('parseColorFgBg', () => {
  it.each([
    ['0;15', 'light'],
    ['0;7', 'light'],
    ['0;default;15', 'light'],
    ['15;0', 'dark'],
    ['15;8', 'dark'],
    ['7;0', 'dark'],
  ] as const)('%s means a %s background', (value, expected) => {
    expect(parseColorFgBg(value)).toBe(expected);
  });

  it.each([undefined, '', 'garbage', '15', '15;x', '0;99'])('returns undefined for %j', (value) => {
    expect(parseColorFgBg(value)).toBeUndefined();
  });
});

describe('parseOsc11Response', () => {
  it('parses a 16-bit-per-channel reply terminated by BEL', () => {
    expect(parseOsc11Response('\u001B]11;rgb:ffff/ffff/ffff\u0007')).toEqual({ r: 255, g: 255, b: 255 });
  });

  it('parses an 8-bit-per-channel reply terminated by ST', () => {
    expect(parseOsc11Response('\u001B]11;rgb:1e/1e/2e\u001B\\')).toEqual({ r: 0x1e, g: 0x1e, b: 0x2e });
  });

  it('parses a 12-bit and 4-bit reply by scaling to 8 bits', () => {
    expect(parseOsc11Response('\u001B]11;rgb:fff/000/fff\u0007')).toEqual({ r: 255, g: 0, b: 255 });
    expect(parseOsc11Response('\u001B]11;rgb:f/0/f\u0007')).toEqual({ r: 255, g: 0, b: 255 });
  });

  it('tolerates an alpha channel some terminals append', () => {
    expect(parseOsc11Response('\u001B]11;rgba:0000/0000/0000/ffff\u0007')).toEqual({ r: 0, g: 0, b: 0 });
  });

  it('returns undefined for anything that is not an OSC 11 colour reply', () => {
    expect(parseOsc11Response('')).toBeUndefined();
    expect(parseOsc11Response('hello')).toBeUndefined();
    expect(parseOsc11Response('\u001B]11;?\u0007')).toBeUndefined();
  });
});

describe('backgroundModeFromRgb', () => {
  it('classifies by perceived luminance, not by any single channel', () => {
    expect(backgroundModeFromRgb({ r: 255, g: 255, b: 255 })).toBe('light');
    expect(backgroundModeFromRgb({ r: 13, g: 17, b: 23 })).toBe('dark');
    // Solarized Light base3: light despite a low blue channel.
    expect(backgroundModeFromRgb({ r: 253, g: 246, b: 227 })).toBe('light');
    // Pure blue is dark to the eye even though one channel is saturated.
    expect(backgroundModeFromRgb({ r: 0, g: 0, b: 255 })).toBe('dark');
  });
});
