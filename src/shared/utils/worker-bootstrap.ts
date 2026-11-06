import { fileURLToPath } from 'node:url';

/** Keep bootstrap recovery worker-local; never change the caller's cwd or startup flags. */
export function workerBootstrapExecArgv(): string[] {
  const preload = new URL(
    import.meta.url.endsWith('.ts') ? './worker-cwd-preload.cts' : './worker-cwd-preload.cjs',
    import.meta.url,
  );
  return ['--require', fileURLToPath(preload), ...process.execArgv];
}
