import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = path.join(root, 'web-client');
const dist = path.join(root, 'dist');
const output = path.join(dist, 'web-client', '.next');
if (!existsSync(path.join(dist, 'cli.js'))) throw new Error('Run pnpm build before packing term2.');

// The browser's copy of the shared fold comes from src/protocol/fold/, not from web-client/ itself.
execFileSync(process.execPath, [path.join(root, 'scripts/build-web-fold.mjs')], { stdio: 'inherit' });

// Build from source, never from a developer's dev server output. No local dotenv
// files are staged, and public flags needed by the packaged app are fixed here.
execFileSync(process.execPath, [path.join(source, 'node_modules/next/dist/bin/next'), 'build', '--webpack'], {
  cwd: source,
  stdio: 'inherit',
  env: {
    ...process.env,
    NODE_ENV: 'production',
    NEXT_TELEMETRY_DISABLED: '1',
    NEXT_PUBLIC_TERM2_UI_ENABLED: 'true',
    NEXT_PUBLIC_TERM2_LOCAL_CONTROL_ENABLED: 'true',
  },
});

const built = path.join(source, '.next');
const buildOnly = new Set(['cache', 'diagnostics', 'types', 'trace', 'trace-build']);
rmSync(output, { recursive: true, force: true });
mkdirSync(path.dirname(output), { recursive: true });
cpSync(built, output, {
  recursive: true,
  filter: (file) => !buildOnly.has(path.relative(built, file).split(path.sep)[0]),
});
const launcher = path.join(dist, 'web.js');
copyFileSync(path.join(root, 'scripts/start-web.mjs'), launcher);
chmodSync(launcher, 0o755);
