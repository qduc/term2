/** Private, crash-durable command bookkeeping; never reads or writes source logs. */
import * as fs from 'node:fs';
import process from 'node:process';
import { dirname, join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { nativeIdForSource } from './source-identity.mjs';

const HASH = /^[0-9a-f]{64}$/;

// Resolve missing leaves without following even an existing directory symlink.
function plainPath(value) {
  if (typeof value !== 'string' || !value) throw new Error('invalid path');
  const path = resolve(value);
  let cursor = path;
  for (;;) {
    try {
      if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error('aliased path');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (dirname(cursor) === cursor) break;
    cursor = dirname(cursor);
  }
  return path;
}

function overlaps(a, b) {
  return a === b || a.startsWith(b + sep) || b.startsWith(a + sep);
}

/** Require explicit disjoint namespaces, with a dedicated private map parent. */
export function preparePaths({ sourceCopy, destination, provenance }) {
  const source = plainPath(sourceCopy);
  const native = plainPath(destination);
  const map = plainPath(provenance);
  const privateDirectory = dirname(map);
  if ([source, native, privateDirectory].some((path) => dirname(path) === path)) throw new Error('root namespace');
  if (overlaps(source, native) || overlaps(source, privateDirectory) || overlaps(native, privateDirectory))
    throw new Error('overlapping namespaces');
  // Source and destination must already exist: no implicit/live directory defaults.
  if (!fs.lstatSync(source).isDirectory() || !fs.lstatSync(native).isDirectory()) throw new Error('directory required');
  if (fs.realpathSync(source) !== source || fs.realpathSync(native) !== native) throw new Error('aliased namespace');
  const a = fs.statSync(source);
  const b = fs.statSync(native);
  if (a.dev === b.dev && a.ino === b.ino) throw new Error('aliased namespace');
  fs.mkdirSync(privateDirectory, { recursive: true, mode: 0o700 });
  const p = fs.lstatSync(privateDirectory);
  if (!p.isDirectory() || (p.mode & 0o777) !== 0o700 || p.uid !== process.getuid?.())
    throw new Error('private directory required');
  if ((p.dev === a.dev && p.ino === a.ino) || (p.dev === b.dev && p.ino === b.ino))
    throw new Error('aliased private namespace');
  // Make recursive mkdir ancestry durable before any native publication can occur.
  for (let cursor = privateDirectory; ; cursor = dirname(cursor)) {
    syncPath(cursor);
    if (dirname(cursor) === cursor) break;
  }
  // Never share the permanent SQLite lock name with the replaceable map.
  if (map === join(privateDirectory, 'command-authority') || map === join(privateDirectory, 'conv_locks'))
    throw new Error('reserved map name');
  return { source, native, map, privateDirectory };
}

export function syncPath(path) {
  const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function sourceValid(source) {
  return source && HASH.test(source.canonical) && (source.deltas === null || HASH.test(source.deltas));
}

/** Reject malformed/foreign maps instead of silently adopting or replacing them. */
export function readProvenance(paths) {
  const binding = { source: paths.source, destination: paths.native };
  let bytes;
  try {
    const stat = fs.lstatSync(paths.map);
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid?.())
      throw new Error('unsafe map');
    const fd = fs.openSync(paths.map, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      bytes = fs.readFileSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { format: 'term2-offline-migration-1', ...binding, records: {} };
  }
  const state = JSON.parse(bytes);
  if (
    state?.format !== 'term2-offline-migration-1' ||
    state.source !== binding.source ||
    state.destination !== binding.destination ||
    !state.records ||
    typeof state.records !== 'object' ||
    Array.isArray(state.records)
  )
    throw new Error('foreign map');
  for (const [id, record] of Object.entries(state.records)) {
    if (
      !nativeIdForSource(id) ||
      record?.id !== nativeIdForSource(id) ||
      !['pending', 'complete'].includes(record.status) ||
      !sourceValid(record.source) ||
      !Number.isSafeInteger(record.bytes) ||
      record.bytes < 1 ||
      !HASH.test(record.sha256) ||
      !Number.isSafeInteger(record.throughSeq) ||
      record.throughSeq < 1
    )
      throw new Error('invalid map record');
  }
  return state;
}

/** fsync temporary 0600 bytes, atomic rename, then fsync the containing directory. */
export function writeProvenance(paths, state) {
  const temporary = join(paths.privateDirectory, `.migration-${randomUUID()}.tmp`);
  let fd;
  let created = false;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    created = true;
    fs.writeFileSync(fd, JSON.stringify(state) + '\n');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, paths.map);
    syncPath(paths.privateDirectory);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (created) fs.rmSync(temporary, { force: true });
  }
}
