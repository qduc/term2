/* global AbortController */
import process from 'node:process';
import { Buffer } from 'node:buffer';
import console from 'node:console';
import { URL } from 'node:url';
import { spawn } from 'node:child_process';
import { readFile, mkdir, writeFile, unlink, rmdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export const DEFAULT_MAX_HANDOFF_BYTES = 32_768;
const refusal = (code, message) => Object.assign(new Error(message), { code });

// Linux start-time identity prevents a reused supervisor PID keeping an orphan alive.
export async function processIdentity(pid) {
  const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  if (fields[0] === 'Z') throw refusal('owner_exited', 'Process has exited');
  return fields[19];
}

export async function readHandoff(path, maxBytes = DEFAULT_MAX_HANDOFF_BYTES) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError('Invalid handoff byte ceiling');
  const file = await open(path, 'r');
  try {
    // Bound the read itself, including a file that grows after stat().
    const buffer = Buffer.alloc(maxBytes + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const read = await file.read(buffer, bytes, buffer.length - bytes, null);
      if (read.bytesRead === 0) break;
      bytes += read.bytesRead;
    }
    if (bytes > maxBytes)
      throw refusal(
        'handoff_too_large',
        `Handoff exceeds ${maxBytes} UTF-8 bytes. Preserve the source file and provide a concise state summary with artifact references; no truncation or model call was performed.`,
      );
    return buffer.subarray(0, bytes).toString('utf8');
  } finally {
    await file.close();
  }
}

function groupAlive(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}
function signalGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

/** Own one local Node worker and all descendants remaining in its process group. */
export async function startSupervised({
  entry,
  args = [],
  handoff,
  promptFile,
  lockDir,
  cwd,
  env = process.env,
  imports = [],
}) {
  if (process.platform !== 'linux')
    throw refusal('unsupported_platform', 'Verified process ownership currently requires Linux /proc');
  const prompt = promptFile ? await readHandoff(promptFile) : handoff;
  if (typeof prompt !== 'string' || Buffer.byteLength(prompt) > DEFAULT_MAX_HANDOFF_BYTES) {
    throw refusal(
      'handoff_too_large',
      'Provide a handoff of at most 32768 UTF-8 bytes; source evidence must remain in artifacts.',
    );
  }
  const supervisorIdentity = await processIdentity(process.pid);
  try {
    await mkdir(lockDir);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    throw refusal(
      'worker_owned',
      `Worker ownership exists at ${lockDir}. Inspect owner.json and prove the old process group stopped before recovering a stale lock; no replacement was launched.`,
    );
  }
  const ownerFile = join(lockDir, 'owner.json');
  let child;
  let exit;
  try {
    await writeFile(ownerFile, JSON.stringify({ supervisorPid: process.pid, supervisorIdentity }), {
      flag: 'wx',
      mode: 0o600,
    });
    child = spawn(
      process.execPath,
      [
        '--import',
        fileURLToPath(new URL('./worker-owner.mjs', import.meta.url)),
        ...imports.flatMap((path) => ['--import', path]),
        entry,
        ...args,
      ],
      {
        cwd,
        detached: true,
        stdio: ['inherit', 'inherit', 'inherit', 'pipe'],
        env: {
          ...env,
          TERM2_SUPERVISED: '1',
          TERM2_SUPERVISOR_OWNER: JSON.stringify({ pid: process.pid, identity: supervisorIdentity }),
        },
      },
    );
    // Attach before the first await: even an immediate child exit must settle.
    exit = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    void exit.catch(() => {});
    if (!child.pid) throw refusal('worker_spawn_failed', 'Worker could not be spawned');
    // Pass private task content through a pipe rather than OS-visible argv.
    child.stdio[3].on('error', () => {}); // child startup failures settle via exit/error
    await writeFile(
      ownerFile,
      JSON.stringify({ supervisorPid: process.pid, supervisorIdentity, workerPid: child.pid, processGroup: child.pid }),
      { mode: 0o600 },
    );
    // The preload waits on this pipe; application code cannot start before
    // its ownership record is committed by the supervisor.
    child.stdio[3].end(prompt);
  } catch (error) {
    if (child?.pid) signalGroup(child.pid, 'SIGKILL');
    // Failed launch leaves ownership evidence when termination is not proven.
    if (!child?.pid) {
      await unlink(ownerFile).catch(() => {});
      await rmdir(lockDir);
    }
    throw error;
  }
  let stopping;
  const stop = () =>
    (stopping ??= (async () => {
      signalGroup(child.pid, 'SIGTERM');
      const grace = new AbortController();
      try {
        await Promise.race([exit, delay(5_000, undefined, { signal: grace.signal })]);
      } finally {
        grace.abort();
      }
      if (groupAlive(child.pid)) signalGroup(child.pid, 'SIGKILL');
      await exit;
      for (let attempt = 0; attempt < 50 && groupAlive(child.pid); attempt++) await delay(20);
      if (groupAlive(child.pid))
        throw refusal(
          'worker_stop_unproven',
          `Process group ${child.pid} still exists; lock retained and replacement refused.`,
        );
    })());
  const onTerm = () => {
    void stop().catch((error) => {
      console.error(error.code);
    });
  };
  process.on('SIGTERM', onTerm);
  process.on('SIGINT', onTerm);
  const completed = exit
    .then(async (result) => {
      await stop();
      await unlink(ownerFile);
      await rmdir(lockDir);
      return result;
    })
    .finally(() => {
      process.off('SIGTERM', onTerm);
      process.off('SIGINT', onTerm);
    });
  // Consumers may await stop first, but must never create an unhandled rejection.
  void completed.catch(() => {});
  return {
    child,
    completed,
    stop: async () => {
      await stop();
      await completed;
    },
  };
}
