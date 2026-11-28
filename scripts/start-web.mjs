#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

// `pnpm dev:web` runs this file from scripts/ with TERM2_WEB_DEV=1: it serves the
// web-client sources with `next dev` against the repository's built CLI.
const dev = process.env.TERM2_WEB_DEV === '1';
const project = fileURLToPath(new URL(dev ? '../web-client/' : './web-client/', import.meta.url));
const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(
    [
      'Usage: term2-web [options]',
      'Start the local term2 gateway and web interface (PORT defaults to 3000).',
      '',
      'Options:',
      '  --read-only                Only allow read-only folder access (read-and-write is allowed by default)',
      '  --port <port>              Port for the local web interface (overrides PORT env var)',
      '  -h, --help                 Show this help message',
    ].join('\n'),
  );
  process.exit(0);
}
let allowWrite = true;
let portOverride;
for (let index = 0; index < argv.length; index += 1) {
  const token = argv[index];
  if (token === '--read-only') {
    allowWrite = false;
  } else if (token === '--allow-write') {
    // The default since read-and-write became opt-out; still accepted for existing scripts.
  } else if (token === '--port') {
    const value = argv[index + 1];
    if (!value || !/^\d+$/.test(value)) {
      console.error('term2-web: --port requires a numeric port');
      process.exit(1);
    }
    portOverride = value;
    index += 1;
  } else {
    console.error(`term2-web: unknown option "${token}" (use --help for usage)`);
    process.exit(1);
  }
}
if (dev && !existsSync(fileURLToPath(new URL('../dist/cli.js', import.meta.url)))) {
  console.error('Run pnpm build (or pnpm dev) first: the web dev server needs the built term2 CLI.');
  process.exit(1);
}
if (dev) {
  // `next dev` serves web-client sources that import the generated fold bundle, which is not committed
  // and is otherwise only produced by build-web.mjs and CI. Regenerate it so a fresh checkout starts
  // and an edited src/protocol/fold/ is picked up on restart.
  execFileSync(process.execPath, [fileURLToPath(new URL('./build-web-fold.mjs', import.meta.url))], {
    stdio: 'inherit',
  });
}
if (!dev && !existsSync(path.join(project, '.next', 'BUILD_ID'))) {
  console.error('The term2 web build is missing. Reinstall the npm package, or pack it after running pnpm build.');
  process.exit(1);
}

const cli = fileURLToPath(new URL(dev ? '../dist/cli.js' : './cli.js', import.meta.url));
const next = createRequire(dev ? path.join(project, 'package.json') : import.meta.url).resolve('next/dist/bin/next');
const children = [];
let stop;
const stopped = new Promise((resolve) => {
  stop = resolve;
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stop(0));

function start(args, options) {
  const child = spawn(process.execPath, args, options);
  const done = once(child, 'close').then(([code]) => code ?? 1);
  // Observe an early exit even when another child is still starting.
  done.then(
    (code) => stop(code || 1),
    (error) => {
      console.error(`term2-web: ${error.message}`);
      stop(1);
    },
  );
  children.push({ child, done });
  return child;
}

// A private per-launch socket and signing key need neither a pairing exchange nor
// writes to the installed package. Gateway conversation state is still persistent.
const dir = mkdtempSync(path.join(tmpdir(), 't2-'));
try {
  const socket = path.join(dir, 's');
  const key = path.join(dir, 'key.pem');
  const publicKeyPath = path.join(dir, 'pub.pem');
  const owner = 'local-owner';
  const keyId = 'term2-web';
  const issuer = 'chatforge-bff';
  const audience = 'term2-gateway';
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  writeFileSync(key, privateKey, { mode: 0o600 });
  writeFileSync(publicKeyPath, publicKey);

  const serveArgs = [
    cli,
    'serve',
    '--socket',
    socket,
    '--local-owner',
    owner,
    '--issuer',
    issuer,
    '--audience',
    audience,
    '--bff-key',
    `${keyId}=${publicKeyPath}`,
    ...(allowWrite ? ['--allow-write'] : []),
  ];
  const gateway = start(serveArgs, { stdio: ['ignore', 'inherit', 'pipe'] });
  const ready = new Promise((resolve) => {
    createInterface({ input: gateway.stderr }).on('line', (line) => {
      if (line.startsWith('GATEWAY_READY ')) resolve(true);
      else console.error(line);
    });
  });
  if ((await Promise.race([ready, stopped])) === true) {
    // Do not expose the single-owner BFF to the network or inherit pairing settings.
    start([next, dev ? 'dev' : 'start', project, '--hostname', '127.0.0.1'], {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: {
        ...process.env,
        ...(portOverride !== undefined ? { PORT: portOverride } : {}),
        NODE_ENV: dev ? 'development' : 'production',
        NEXT_TELEMETRY_DISABLED: '1',
        TERM2_PACKAGED_WEB: 'true',
        TERM2_WEB_ALLOW_WRITE: allowWrite ? 'true' : 'false',
        TERM2_WEB_CLIENT_ALLOWED_HOSTS: '',
        TERM2_GATEWAY_SOCKET_PATH: socket,
        TERM2_GATEWAY_BFF_PRIVATE_KEY_PATH: key,
        TERM2_LOCAL_OWNER_USER_ID: owner,
        TERM2_GATEWAY_KEY_ID: keyId,
        TERM2_GATEWAY_ISSUER: issuer,
        TERM2_GATEWAY_AUDIENCE: audience,
        TERM2_GATEWAY_PAIRING_ENABLED: 'false',
      },
    });
  }
  process.exitCode = await stopped;
} finally {
  for (const { child } of children) child.kill('SIGTERM');
  const deadline = setTimeout(() => {
    for (const { child } of children) child.kill('SIGKILL');
  }, 5000);
  await Promise.allSettled(children.map(({ done }) => done));
  clearTimeout(deadline);
  rmSync(dir, { recursive: true, force: true });
}
