import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sol-network-kill-'));
const cwd = process.cwd();
const worker = spawn(
  process.execPath,
  ['--import', 'tsx', fileURLToPath(new URL('./c3a-network-kill-worker.mts', import.meta.url))],
  { cwd, env: { ...process.env, PROBE_ROOT: root }, stdio: ['ignore', 'pipe', 'pipe'] },
);
let out = '',
  err = '';
worker.stderr.on('data', (b) => (err += b));
let timer = setTimeout(() => worker.kill('SIGKILL'), 45000);
for (let i = 0; i < 2000 && !fs.existsSync(path.join(root, 'ready.json')); i++)
  await new Promise((r) => setTimeout(r, 10));
assert.ok(fs.existsSync(path.join(root, 'ready.json')), 'no durable ready ' + out + ' ' + err);
const pending = JSON.parse(fs.readFileSync(path.join(root, 'ready.json'), 'utf8'));
clearTimeout(timer);
worker.kill('SIGKILL');
const [, signal] = await once(worker, 'exit');
assert.equal(signal, 'SIGKILL');
const reopen = spawn(
  process.execPath,
  ['--import', 'tsx', fileURLToPath(new URL('./c3a-network-kill-worker.mts', import.meta.url))],
  {
    cwd,
    env: {
      ...process.env,
      PROBE_ROOT: root,
      WORKER_MODE: 'reopen',
      SESSION_ID: pending.id,
      REQUEST_ID: pending.requestId,
      GENERATION: pending.generation,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
let second = '',
  secondErr = '';
reopen.stdout.on('data', (b) => (second += b));
reopen.stderr.on('data', (b) => (secondErr += b));
timer = setTimeout(() => reopen.kill('SIGKILL'), 45000);
const [code] = await once(reopen, 'exit');
clearTimeout(timer);
assert.equal(code, 0, second + ' ' + secondErr);
assert.ok(fs.existsSync(path.join(root, 'reopened.json')));
fs.rmSync(root, { recursive: true, force: true });
console.log(
  'PASS actual Session idle pending network SIGKILL/fresh process recovered/stale decision rejected/zero auto dispatch',
);
