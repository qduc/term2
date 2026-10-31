import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'c3a-stage4-kill-'));
const run = (extra: any) =>
  spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./c3a-toolkill-worker.mts', import.meta.url))], {
    env: { ...process.env, PROBE_ROOT: root, ...extra },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
let child = run({}),
  out = '',
  err = '';
child.stdout.on('data', (x) => (out += x));
child.stderr.on('data', (x) => (err += x));
let shellPid = 0;
async function until(f: () => any, label: string) {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    const v = f();
    if (v) return v;
    if (child.exitCode !== null) throw Error('early exit ' + err + ' ' + out);
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error('timeout ' + label + ' ' + err + ' ' + out);
}
try {
  const match = await until(() => out.match(/STARTED (\S+)/), 'durable tool_started');
  await until(
    () => fs.existsSync(path.join(root, 'shell-pid')) && fs.existsSync(path.join(root, 'workspace', 'effect.txt')),
    'in-flight effect',
  );
  shellPid = Number(fs.readFileSync(path.join(root, 'shell-pid'), 'utf8'));
  assert.ok(shellPid > 0);
  assert.equal(fs.readFileSync(path.join(root, 'workspace', 'effect.txt'), 'utf8'), 'one');
  const exited = new Promise((r) => child.once('exit', r));
  child.kill('SIGKILL');
  await exited;
  assert.equal(fs.readFileSync(path.join(root, 'provider-count'), 'utf8'), 'x');
  process.kill(shellPid, 'SIGKILL');
  await until(() => {
    try {
      const st = fs.readFileSync(`/proc/${shellPid}/stat`, 'utf8');
      return st.slice(st.lastIndexOf(')') + 2).startsWith('Z');
    } catch {
      return true;
    }
  }, 'shell process dead');
  shellPid = 0;
  child = run({ REOPEN_ID: match[1] });
  out = '';
  err = '';
  child.stdout.on('data', (x) => (out += x));
  child.stderr.on('data', (x) => (err += x));
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('reopen timeout ' + err)), 15000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  assert.equal(code, 0, err + ' ' + out);
  assert.ok(out.includes('REOPEN_PASS'));
  assert.equal(fs.readFileSync(path.join(root, 'provider-count'), 'utf8'), 'xx');
  assert.equal(fs.readFileSync(path.join(root, 'workspace', 'effect.txt'), 'utf8'), 'one');
  console.log(out);
  console.log('PASS actual tool SIGKILL fresh process idempotent recovery and explicit followup no replay');
} finally {
  child.kill('SIGKILL');
  if (shellPid)
    try {
      process.kill(shellPid, 'SIGKILL');
    } catch {}
  fs.rmSync(root, { recursive: true, force: true });
}
