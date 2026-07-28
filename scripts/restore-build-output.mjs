import { fileURLToPath } from 'node:url';
import { restorePreviousBuild } from './build-output.mjs';

/**
 * `pnpm build:restore` entry point. Rolls `dist/` back to the build kept aside
 * by the previous `pnpm build`.
 *
 * Useful when a build succeeds but the resulting CLI misbehaves — the failure
 * case is already handled automatically by `pnpm build`.
 */

const restored = await restorePreviousBuild({
  distDir: fileURLToPath(new URL('../dist/', import.meta.url)),
  backupDir: fileURLToPath(new URL('../dist.bak/', import.meta.url)),
});

if (!restored) {
  console.error('[build:restore] no dist.bak/ to restore from');
  process.exit(1);
}

console.log('[build:restore] restored dist/ from dist.bak/');
