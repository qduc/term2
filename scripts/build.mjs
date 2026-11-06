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
// package.json bin.term2. A static import keeps argv[1] (used by restart) on this file.
fs.writeFileSync(path.join(dist, 'cli.js'), "#!/usr/bin/env node\nimport './src/app/cli.js';\n", {
  mode: 0o755,
});
fs.writeFileSync(path.join(dist, 'cli.d.ts'), 'export {};\n');
// The gateway imports @qduc/agent-wire, a vendored dev dependency; ship a copy beside the build.
const embed = spawnSync(process.execPath, ['scripts/embed-agent-wire.mjs'], { cwd: repo, stdio: 'inherit' });
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
