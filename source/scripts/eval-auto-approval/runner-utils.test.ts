import test from 'ava';
import { createCacheKey, EVAL_CACHE_VERSION, getReportPath, validateRunnerOptions } from './runner-utils.js';

test('getReportPath produces a distinct markdown path for json and extensionless outputs', (t) => {
  t.is(getReportPath('eval/auto-approval/results.json'), 'eval/auto-approval/results.md');
  t.is(getReportPath('eval/auto-approval/results'), 'eval/auto-approval/results.md');
});

test('validateRunnerOptions rejects non-positive concurrency and repeat values', (t) => {
  t.notThrows(() => validateRunnerOptions({ concurrency: 1, repeat: 1 }));
  t.throws(() => validateRunnerOptions({ concurrency: 0, repeat: 1 }), {
    message: /--concurrency/,
  });
  t.throws(() => validateRunnerOptions({ concurrency: 1, repeat: 0 }), {
    message: /--repeat/,
  });
});

test('createCacheKey includes evaluator version to invalidate stale cached decisions', (t) => {
  const key = createCacheKey({
    model: 'gpt-4o-mini',
    provider: 'openai',
    command: 'ls',
    history: [{ role: 'user', content: 'list files' }],
  });

  t.is(key.version, EVAL_CACHE_VERSION);
});
