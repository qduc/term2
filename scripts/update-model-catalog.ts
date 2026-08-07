#!/usr/bin/env node
/**
 * Regenerate source/providers/model-catalog/catalog.generated.ts from a
 * @earendil-works/pi-ai checkout.
 *
 * Usage:
 *   pnpm catalog:update
 *
 * The script locates pi-ai via Node module resolution (install it as a dev
 * dependency) or from PI_AI_DATA_DIR pointing at its dist/providers/data
 * directory. Nothing is fetched over the network; the vendored catalog is a
 * snapshot of the pi-ai data at generation time.
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  generateCatalogSource,
  VENDORED_PI_PROVIDERS,
  type PiProviderData,
} from '../source/providers/model-catalog/generate-catalog.js';

const require = createRequire(import.meta.url);

// This file lives at <root>/scripts/update-model-catalog.ts.
const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const outputPath = join(repoRoot, 'source', 'providers', 'model-catalog', 'catalog.generated.ts');

/** Format generated TypeScript through prettier so the artifact stays lint-clean. */
async function formatTypeScript(source: string): Promise<string> {
  try {
    // prettier 2.x is CommonJS; its default export carries format/resolveConfig.
    const prettier = (await import('prettier')).default;
    const options = await prettier.resolveConfig(repoRoot);
    return await prettier.format(source, { ...options, parser: 'typescript' });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`Warning: prettier formatting failed (${reason}); writing unformatted output.`);
    return source;
  }
}

async function resolvePiAiDataDir(): Promise<string> {
  const envDir = process.env.PI_AI_DATA_DIR;
  if (envDir) return resolve(envDir);
  try {
    const pkgJsonPath = require.resolve('@earendil-works/pi-ai/package.json');
    return join(dirname(pkgJsonPath), 'dist', 'providers', 'data');
  } catch {
    throw new Error(
      'Cannot locate @earendil-works/pi-ai. Install it (pnpm add -D @earendil-works/pi-ai) or point PI_AI_DATA_DIR ' +
        'at a pi-ai dist/providers/data directory.',
    );
  }
}

async function main(): Promise<void> {
  const dataDir = await resolvePiAiDataDir();

  const piData: Record<string, PiProviderData> = {};
  const missing: string[] = [];
  for (const { file } of VENDORED_PI_PROVIDERS) {
    try {
      const raw = await readFile(join(dataDir, `${file}.json`), 'utf8');
      piData[file] = JSON.parse(raw) as PiProviderData;
    } catch {
      missing.push(`${file}.json`);
    }
  }
  if (missing.length > 0) {
    throw new Error(`Missing pi-ai provider data files in ${dataDir}: ${missing.join(', ')}`);
  }

  let generatedAt: string | undefined;
  try {
    const manifest = JSON.parse(await readFile(join(dataDir, '.manifest.json'), 'utf8')) as { generatedAt?: string };
    generatedAt = manifest.generatedAt;
  } catch {
    generatedAt = new Date().toISOString();
  }

  let piVersion = 'unknown';
  try {
    const pkg = JSON.parse(await readFile(join(dirname(dataDir), '..', '..', 'package.json'), 'utf8')) as {
      version?: string;
    };
    piVersion = pkg.version ?? 'unknown';
  } catch {
    // version stays "unknown"
  }

  const source = await formatTypeScript(
    generateCatalogSource(piData, {
      schemaVersion: 2,
      generatedAt: generatedAt ?? new Date().toISOString(),
      source: `pi-ai@${piVersion}`,
    }),
  );

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, source, 'utf8');

  const counts = VENDORED_PI_PROVIDERS.map(({ file, provider }) => {
    const count = Object.values(piData[file] ?? {}).reduce(
      (sum, apiType) => sum + Object.values(apiType).filter((m) => (m.contextWindow ?? 0) > 0).length,
      0,
    );
    return `${provider}: ${count}`;
  });
  console.log(`Wrote ${outputPath}`);
  console.log(`Models vendored (${counts.join(', ')})`);
  console.log(`Source: pi-ai@${piVersion} data generated ${generatedAt}`);
}

await main();
