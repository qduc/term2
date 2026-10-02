import { describe, expect, it } from 'vitest';
import { contextTone, gaugeBar } from './gauge.js';

describe('contextTone', () => {
  it.each([
    [undefined, 'textSubtle'],
    [0, 'textSubtle'],
    [74, 'textSubtle'],
    [75, 'warning'],
    [89, 'warning'],
    [90, 'danger'],
    [100, 'danger'],
  ] as const)('%s%% is %s', (percent, tone) => {
    expect(contextTone(percent)).toBe(tone);
  });
});

describe('gaugeBar', () => {
  it.each([
    [0, 8, '▱▱▱▱▱▱▱▱'],
    [50, 8, '▰▰▰▰▱▱▱▱'],
    [100, 8, '▰▰▰▰▰▰▰▰'],
    [84, 10, '▰▰▰▰▰▰▰▰▱▱'],
  ])('%s%% in %i cells is %s', (percent, cells, expected) => {
    expect(gaugeBar(percent, cells)).toBe(expected);
  });

  it('always fills at least one cell for a non-zero percentage, so a little is not drawn as none', () => {
    expect(gaugeBar(1, 10)).toBe('▰▱▱▱▱▱▱▱▱▱');
  });

  it('clamps out-of-range input and is always exactly the requested width', () => {
    expect(gaugeBar(-20, 6)).toBe('▱▱▱▱▱▱');
    expect(gaugeBar(250, 6)).toBe('▰▰▰▰▰▰');
    for (const percent of [0, 3, 33, 66, 99, 100, 140]) {
      expect(Array.from(gaugeBar(percent, 7))).toHaveLength(7);
    }
  });
});
