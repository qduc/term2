import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { inject } from 'vitest';

declare module 'vitest' {
  export interface ProvidedContext {
    providerRecorderBundle: string;
  }
}

const recorderPath = fileURLToPath(new URL('../provider-record.ts', import.meta.url));
const repoRoot = resolve(dirname(recorderPath), '..');

/**
 * Bundle `scripts/provider-record.ts` once per suite run so the recorder tests launch plain `node`
 * instead of paying `pnpm exec tsx` startup and TypeScript transpilation on every test case.
 *
 * The output lives under `node_modules/.cache/` so Node's ESM resolver finds external packages
 * natively while staying outside git and CI's dependency cache. `import.meta.url` in repo source
 * files is rewritten to each file's real URL so relative paths (like `repoRoot` and `createRequire`)
 * behave identically to running `scripts/provider-record.ts` directly.
 */
export async function bundleProviderRecorder(): Promise<{ bundlePath: string; cleanup: () => void }> {
  const cacheBase = join(repoRoot, 'node_modules', '.cache');
  mkdirSync(cacheBase, { recursive: true });
  const dir = mkdtempSync(join(cacheBase, 'term2-provider-record-'));
  const bundlePath = join(dir, 'provider-record.mjs');

  const ownImportMeta = {
    name: 'own-import-meta',
    setup(pluginBuild: import('esbuild').PluginBuild) {
      pluginBuild.onLoad({ filter: /\.ts$/ }, (args) => {
        if (!args.path.startsWith(repoRoot) || args.path.includes(`${join('node_modules', '')}`)) return undefined;
        const code = readFileSync(args.path, 'utf8');
        if (!code.includes('import.meta.')) return undefined;
        const url = JSON.stringify(pathToFileURL(args.path).href);
        const filename = JSON.stringify(args.path);
        const dirName = JSON.stringify(dirname(args.path));
        return {
          loader: 'ts',
          contents: code
            .replace(/\bimport\.meta\.url\b/g, url)
            .replace(/\bimport\.meta\.filename\b/g, filename)
            .replace(/\bimport\.meta\.dirname\b/g, dirName),
        };
      });
    },
  };

  try {
    await build({
      entryPoints: [recorderPath],
      outfile: bundlePath,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      packages: 'external',
      logLevel: 'warning',
      plugins: [ownImportMeta],
    });
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }

  return {
    bundlePath,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Return the pre-bundled `provider-record.mjs` path provided by `global-setup.ts`. */
export function resolveProviderRecorderBundle(): string {
  const bundlePath = inject('providerRecorderBundle');
  if (!bundlePath) {
    throw new Error('providerRecorderBundle was not provided by scripts/provider-black-box/global-setup.ts');
  }
  return bundlePath;
}
