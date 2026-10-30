import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
for (const target of ['turn', 'tool']) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'c3a-retry-kill-'));
  let child: any;
  const run = (extra: any = {}) =>
    spawn(
      process.execPath,
      ['--import', 'tsx', fileURLToPath(new URL('./c3a-retry-kill-worker.mts', import.meta.url))],
      {
        env: {
          ...process.env,
          PROBE_ROOT: root,
          RETRY_TARGET: target,
          NODE_OPTIONS: '--unhandled-rejections=strict',
          ...extra,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
  try {
    child = run();
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (x: any) => (stdout += x));
    child.stderr.on('data', (x: any) => (stderr += x));
    const exit: any = await new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        child.kill('SIGKILL');
        reject(Error('boundary timeout ' + stderr + ' ' + stdout));
      }, 20000);
      child.on('exit', (code: any, signal: any) => {
        clearTimeout(t);
        resolve({ code, signal });
      });
    });
    assert.equal(exit.signal, 'SIGKILL', stderr + ' ' + stdout);
    const boundary = JSON.parse(fs.readFileSync(path.join(root, 'boundary.json'), 'utf8'));
    assert.equal(boundary.count, target === 'tool' ? 2 : 1);
    child = run({ REOPEN_ID: boundary.id });
    stdout = '';
    stderr = '';
    child.stdout.on('data', (x: any) => (stdout += x));
    child.stderr.on('data', (x: any) => (stderr += x));
    const code = await new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        child.kill('SIGKILL');
        reject(Error('reopen timeout ' + stderr));
      }, 20000);
      child.on('exit', (code: any) => {
        clearTimeout(t);
        resolve(code);
      });
    });
    assert.equal(code, 0, stderr + ' ' + stdout);
    assert.ok(stdout.includes('REOPEN_PASS ' + target), stdout);
    console.log(
      'PASS ' +
        target +
        ' actual app/Engine fsynced retry-before-dispatch SIGKILL -> fresh process graph exact native original + no automatic provider/effect',
    );
  } finally {
    child?.kill('SIGKILL');
    fs.rmSync(root, { recursive: true, force: true });
  }
}
