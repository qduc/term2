import { it, expect } from 'vitest';
import { getInkRenderOptions } from './ink-render-options.js';

it('getInkRenderOptions disables incremental rendering and Ink Ctrl+C exits', () => {
  const options = getInkRenderOptions();

  expect(options.incrementalRendering).toBe(false);
  expect(options.exitOnCtrlC).toBe(false);
});
