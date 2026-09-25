import { describe, expect, it } from 'vitest';
import { isPathInside } from './path-safety.js';

describe('isPathInside', () => {
  it('includes the root and descendants', () => {
    expect(isPathInside('/memory', '/memory')).toBe(true);
    expect(isPathInside('/memory', '/memory/scratch')).toBe(true);
  });

  it('excludes siblings and ancestors', () => {
    expect(isPathInside('/memory', '/memory-other/scratch')).toBe(false);
    expect(isPathInside('/memory', '/')).toBe(false);
  });
});
