/** Unchanged private-directory, advertisement and owned-file identity behavior
 * extracted from the clean v1 control transport. No Session/data access.
 */
import fs from 'node:fs';
import process from 'node:process';
import { connect } from 'node:net';
import { readProcStartTime, type ControlAdvertisement } from './transport-primitives.js';

export class ControlMutationUnavailable extends Error {}

export function isSocketAcceptingConnections(socketPath: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', (cause: NodeJS.ErrnoException) => {
      if (cause.code === 'ECONNREFUSED' || cause.code === 'ENOENT') resolve(false);
      else reject(cause);
    });
  });
}

export function atomicWriteJson(file: string, value: unknown, mode: number): void {
  const temp = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(value)}\n`, { mode, flag: 'wx' });
    fs.chmodSync(temp, mode);
    fs.renameSync(temp, file);
  } finally {
    try {
      fs.unlinkSync(temp);
    } catch {
      /* renamed or already removed */
    }
  }
}

export function ensurePrivateDirectory(directory: string, uid: number): void {
  try {
    fs.mkdirSync(directory, { mode: 0o700 });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause;
  }
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory() || stat.uid !== uid) {
    throw new Error('Control directories must be real directories owned by this user');
  }
  fs.chmodSync(directory, 0o700);
}

export function readAdvertisement(file: string): ControlAdvertisement | null {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (
      value?.v !== 1 ||
      typeof value.name !== 'string' ||
      typeof value.pid !== 'number' ||
      typeof value.startedAt !== 'string' ||
      typeof value.socketPath !== 'string' ||
      typeof value.host !== 'string' ||
      (value.discordInput !== undefined && typeof value.discordInput !== 'boolean')
    )
      return null;
    return value as ControlAdvertisement;
  } catch {
    return null;
  }
}

export function isLiveAdvertisement(
  ad: ControlAdvertisement,
  host: string,
  isPidAlive = defaultPidAlive,
  startTime = readProcStartTime,
): boolean {
  if (ad.host !== host || !isPidAlive(ad.pid)) return false;
  const current = startTime(ad.pid);
  return current === null || current === ad.startedAt;
}

function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}
