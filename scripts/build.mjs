#!/usr/bin/env node
// Build term2 (src) into dist/, the package's only output.
// `pnpm build` wraps this in scripts/build-with-rollback.mjs to keep the previous dist/ recoverable.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildInputs, writeBuildReceipt } from './build-provenance.mjs';
import { writeBuildInfo } from './write-build-info.mjs';
import { bundleEntry } from './bundle-entry.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(repo, 'dist');
const inputs = buildInputs(repo, 'direct');
// Never certify obsolete modules left behind by a source deletion, a failed build or an older layout.
fs.rmSync(dist, { recursive: true, force: true });
const result = spawnSync('pnpm', ['exec', 'tsc', '-p', 'tsconfig.build.json'], {
  cwd: repo,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

// Runtime assets tsc does not emit, copied to the same place under dist/.
for (const asset of ['src/session/prompts', 'src/model/providers/provider-presets.json'])
  fs.cpSync(path.join(repo, asset), path.join(dist, asset), { recursive: true });
// package.json bin.term2. Importing the entry (rather than spawning it) keeps argv[1], used by
// restart, on this file. Enabling Node's compile cache first gives the entry's loader
// (scripts/bundle-loader.mjs) a directory for the bundle's V8 code cache (about 175 of 500 ms to an
// idle TUI), and caches the loader and other ES modules as before. The cache is
// per user, beside term2's other caches: Node's default under os.tmpdir() adopts an existing
// directory even when another user created it writable. Node < 22.1 has no such API and starts
// as before; a cache that cannot be created is skipped, and NODE_COMPILE_CACHE and
// NODE_DISABLE_COMPILE_CACHE take precedence.
fs.writeFileSync(
  path.join(dist, 'cli.js'),
  [
    '#!/usr/bin/env node',
    "import module from 'node:module';",
    "import path from 'node:path';",
    "import envPaths from 'env-paths';",
    "module.enableCompileCache?.(path.join(process.env.TERM2_CACHE_DIR || envPaths('term2').cache, 'node-compile-cache'));",
    "await import('./src/app/cli.js');",
    '',
  ].join('\n'),
  { mode: 0o755 },
);
fs.writeFileSync(path.join(dist, 'cli.d.ts'), 'export {};\n');
// Ship the vendored @qduc/agent-wire beside the build.
const embed = spawnSync(process.execPath, ['scripts/embed-agent-packages.mjs'], { cwd: repo, stdio: 'inherit' });
if (embed.error) throw embed.error;
if (embed.status !== 0) process.exit(embed.status ?? 1);
// After the embed: the gateway's @qduc/agent-wire import resolves to that copy.
await bundleEntry(dist);

await writeBuildInfo({
  root: repo,
  dist,
  runGit(args) {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    return result.status === 0 ? result.stdout.trim() : null;
  },
});
writeBuildReceipt(repo, 'direct', inputs);
