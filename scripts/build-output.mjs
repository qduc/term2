import { existsSync } from 'node:fs';
import { rename, rm } from 'node:fs/promises';

/**
 * Builds an output directory while keeping the previous build recoverable.
 *
 * The build clears its output directory before compiling, so a failed build
 * would otherwise leave no runnable CLI at all — not a stale one, none. This
 * moves the previous build aside instead of deleting it, restores it if any
 * step fails, and otherwise leaves it as a one-generation rollback point.
 *
 * Moving the previous build aside (rather than compiling over it) is also what
 * keeps obsolete compiled modules from surviving a rebuild.
 *
 * @param options.distDir - Directory the build writes to.
 * @param options.backupDir - Directory the previous build is kept in.
 * @param options.steps - Build steps, run in order. Each resolves to an exit code.
 * @param options.backup - When false, the previous build is deleted, not kept.
 * @param options.log - Sink for progress messages.
 * @returns The exit code of the first failing step, or 0.
 */
export async function buildWithRollback({ distDir, backupDir, steps, backup = true, log = () => {} }) {
  const hadPreviousBuild = backup && existsSync(distDir);

  if (hadPreviousBuild) {
    await rm(backupDir, { recursive: true, force: true });
    await rename(distDir, backupDir);
  } else {
    await rm(distDir, { recursive: true, force: true });
  }

  for (const step of steps) {
    const exitCode = await step();
    if (exitCode === 0) {
      continue;
    }

    if (hadPreviousBuild) {
      await rm(distDir, { recursive: true, force: true });
      await rename(backupDir, distDir);
      log('[build] build failed; restored the previous dist/ from dist.bak/');
    } else {
      log('[build] build failed; there was no previous dist/ to restore');
    }
    return exitCode;
  }

  if (hadPreviousBuild) {
    log('[build] previous build kept at dist.bak/ (roll back with: pnpm build:restore)');
  }
  return 0;
}

/**
 * Rolls the output directory back to the kept previous build.
 *
 * @returns Whether a previous build was available to restore.
 */
export async function restorePreviousBuild({ distDir, backupDir }) {
  if (!existsSync(backupDir)) {
    return false;
  }

  await rm(distDir, { recursive: true, force: true });
  await rename(backupDir, distDir);
  return true;
}
