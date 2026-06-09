import test from 'ava';
import { getInkRenderOptions } from './ink-render-options.js';

test('getInkRenderOptions disables incremental rendering', (t) => {
  const options = getInkRenderOptions();

  t.is(options.incrementalRendering, false);
});
