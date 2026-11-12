/* global process, console, fetch, AbortSignal */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Run this launcher, rather than starting run.mjs directly. No inference here.
// Node reads proxy configuration at process startup, so re-exec before fetch.
if ((process.env.HTTPS_PROXY || process.env.https_proxy) && process.env.NODE_USE_ENV_PROXY !== '1') {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    env: { ...process.env, NODE_USE_ENV_PROXY: '1' },
    stdio: 'inherit',
  });
  const [code] = await once(child, 'exit');
  process.exit(code ?? 1);
}
if (process.argv.includes('--live') || process.argv.includes('--probe-only')) {
  for (const [origin, headers] of [
    ['https://api.openai.com', { authorization: `Bearer ${process.env.OPENAI_API_KEY}` }],
    ['https://api.anthropic.com', { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' }],
  ]) {
    try {
      const response = await fetch(`${origin}/v1/models`, { headers, signal: AbortSignal.timeout(15000) });
      await response.body.cancel();
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      console.log(
        JSON.stringify({ preflight: 'read-only-models-list', origin, status: response.status, paidInference: false }),
      );
    } catch (error) {
      // Never serialize request headers or raw client objects.
      console.error(
        JSON.stringify({
          preflight: 'read-only-models-list',
          origin,
          error: error.message,
          code: error.cause?.code ?? null,
        }),
      );
      process.exit(1);
    }
  }
}
if (!process.argv.includes('--probe-only')) {
  const child = spawn(
    process.execPath,
    [path.join(path.dirname(fileURLToPath(import.meta.url)), 'run.mjs'), ...process.argv.slice(2)],
    { env: process.env, stdio: 'inherit' },
  );
  const [code] = await once(child, 'exit');
  process.exit(code ?? 1);
}
