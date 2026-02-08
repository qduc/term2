import test from 'ava';
import { getInkRenderOptions } from '../../dist/utils/ink-render-options.js';

test('getInkRenderOptions enables incremental rendering', (t) => {
  const options = getInkRenderOptions();

  t.is(options.incrementalRendering, true);
});
