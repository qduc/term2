import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { getInkRenderOptions } from './ink-render-options.js';

it('getInkRenderOptions disables incremental rendering', () => {
  const options = getInkRenderOptions();

  expect(options.incrementalRendering).toBe(false);
});
