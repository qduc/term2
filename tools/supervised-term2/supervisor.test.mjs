import process from 'node:process';
import { URL } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSupervised, readHandoff, DEFAULT_MAX_HANDOFF_BYTES } from './supervisor.mjs';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

test('incident continuation is refused without truncating its evidence', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'term2-handoff-'));
  try {
    const file = join(dir, 'handoff');
    await writeFile(file, 'x'.repeat(723470));
    await assert.rejects(readHandoff(file), { code: 'handoff_too_large' });
    assert.equal((await readFile(file)).length, 723470);
    await writeFile(file, 'x'.repeat(DEFAULT_MAX_HANDOFF_BYTES));
    assert.equal((await readHandoff(file)).length, DEFAULT_MAX_HANDOFF_BYTES);
    await writeFile(file, 'x'.repeat(DEFAULT_MAX_HANDOFF_BYTES + 1));
    await assert.rejects(readHandoff(file), { code: 'handoff_too_large' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('live worker ownership rejects a replacement and cancellation proves exit before releasing the lock', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'term2-owner-'));
  try {
    const entry = join(dir, 'worker.mjs');
    await writeFile(entry, 'setInterval(() => {}, 1000);');
    const options = { entry, lockDir: join(dir, 'lock'), args: [], handoff: 'fixture' };
    const worker = await startSupervised(options);
    await assert.rejects(startSupervised(options), { code: 'worker_owned' });
    await worker.stop();
    assert.equal(worker.child.exitCode !== null || worker.child.signalCode !== null, true);
    const replacement = await startSupervised(options);
    await replacement.stop();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a stale lock is not treated as proof the previous worker stopped', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'term2-stale-'));
  try {
    const lockDir = join(dir, 'lock');
    await (await import('node:fs/promises')).mkdir(lockDir);
    await writeFile(join(lockDir, 'owner.json'), JSON.stringify({ supervisorPid: 99999999 }));
    await assert.rejects(startSupervised({ entry: 'unused', args: [], handoff: 'fixture', lockDir }), {
      code: 'worker_owned',
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('killing the supervisor cannot leave a Node worker silently running', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'term2-orphan-'));
  let outer;
  let workerPid;
  try {
    const entry = join(dir, 'worker.mjs');
    const ready = join(dir, 'ready');
    const lockDir = join(dir, 'lock');
    await writeFile(
      entry,
      `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(
        ready,
      )}, String(process.pid)); setInterval(() => {}, 1000);`,
    );
    const driver = join(dir, 'driver.mjs');
    const module = fileURLToPath(new URL('./supervisor.mjs', import.meta.url));
    await writeFile(
      driver,
      `import { startSupervised } from ${JSON.stringify(module)}; const worker = await startSupervised(${JSON.stringify(
        { entry, lockDir, handoff: 'fixture' },
      )}); await worker.completed;`,
    );
    outer = spawn(process.execPath, [driver], { stdio: 'ignore' });
    for (let attempt = 0; attempt < 500 && !workerPid; attempt++) {
      try {
        workerPid = Number(await readFile(ready, 'utf8'));
      } catch {
        await delay(20);
      }
    }
    assert.ok(workerPid, 'fixture worker must have started');
    outer.kill('SIGKILL');
    let alive = true;
    for (let attempt = 0; attempt < 500 && alive; attempt++) {
      try {
        const stat = await readFile(`/proc/${workerPid}/stat`, 'utf8');
        alive = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] !== 'Z';
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        alive = false;
      }
      if (alive) await delay(20);
    }
    assert.equal(alive, false, 'owner watchdog must terminate the orphan');
    await assert.rejects(startSupervised({ entry, lockDir, handoff: 'replacement' }), { code: 'worker_owned' });
    const owner = JSON.parse(await readFile(join(lockDir, 'owner.json'), 'utf8'));
    assert.equal(owner.workerPid, workerPid);
  } finally {
    if (outer?.exitCode === null) outer.kill('SIGKILL');
    if (workerPid) {
      try {
        process.kill(-workerPid, 'SIGKILL');
      } catch {
        // The owned fixture group may already have exited.
      }
    }
    await rm(dir, { recursive: true, force: true });
  }
});
