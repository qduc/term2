import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));
const result = spawnSync(
  process.execPath,
  [
    '--import',
    'tsx',
    '-e',
    `
const assert = require('node:assert/strict');
const { LargeUncachedInputGuard } = require(${JSON.stringify(
      resolve(here, '../../../source/services/large-uncached-input-guard.ts'),
    )});
const idle = 300000;
const make = () => { const g = new LargeUncachedInputGuard({largePromptTokenThreshold: 1}); g.recordSuccessfulInput({provider:'p',model:'m',now:1,input:''}); return g; };
const inspect = (g, now, provider='p') => g.inspect({input:'large input',now,provider,model:'m'});
const g = make();
assert.equal(inspect(g, 1 + idle - 1).action, 'allow', 'below threshold');
assert.equal(inspect(g, 1 + idle).action, 'allow', 'exact threshold');
assert.equal(inspect(g, 1 + idle + 1).action, 'allow', 'idle submission');
assert.equal(inspect(g, 1 + idle + 1, 'other').action, 'warn', 'provider-change approval');
const resumed = new LargeUncachedInputGuard({largePromptTokenThreshold:1});
resumed.markResumedSession({updatedAtMs:1});
assert.equal(inspect(resumed, 1 + idle + 1).action, 'allow', 'stale resumed session');
console.log('PASS: below/exact/above idle boundary; resumed session; provider-change warning preserved');
`,
  ],
  { cwd: resolve(here, '../../..'), encoding: 'utf8' },
);
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exitCode = result.status ?? 1;
