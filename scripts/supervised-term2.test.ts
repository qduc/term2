import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('verifies the real supervisor handoff and process-ownership contracts without a provider', () => {
  const script = fileURLToPath(new URL('../tools/supervised-term2/supervisor.test.mjs', import.meta.url));
  const output = execFileSync(process.execPath, ['--test', script], { encoding: 'utf8', timeout: 20_000 });
  expect(output).toMatch(/(?:#|ℹ) fail 0/);
}, 25_000);
