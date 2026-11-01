/** Offline copy-only migration orchestration. All public reports are fixed-code counts. */
import * as fs from 'node:fs';
import console from 'node:console';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { preparePaths, readProvenance, writeProvenance, syncPath, UUID } from './command-provenance.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const nonempty = (value) => typeof value === 'string' && value.length > 0;
const queueItem = (value) => {
  if (!value || typeof value !== 'object') return false;
  if (
    !nonempty(value.id) ||
    typeof value.text !== 'string' ||
    !Number.isSafeInteger(value.sequence) ||
    value.sequence <= 0 ||
    !nonempty(value.submittedAt) ||
    Number.isNaN(Date.parse(value.submittedAt)) ||
    (value.humanInputAt !== undefined && typeof value.humanInputAt !== 'string') ||
    (value.steer !== undefined && typeof value.steer !== 'boolean')
  )
    return false;
  return (
    value.preflight === undefined ||
    (value.preflight &&
      typeof value.preflight === 'object' &&
      nonempty(value.preflight.actionId) &&
      ['input_surge', 'large_uncached_input'].includes(value.preflight.kind))
  );
};
const validQueueRecord = (value) => {
  if (!value || typeof value !== 'object' || value.version !== 1) return false;
  if (!Number.isSafeInteger(value.nextSequence) || value.nextSequence < 1 || !Array.isArray(value.queue)) return false;
  if (!value.queue.every(queueItem)) return false;
  if (value.queue.some((item, index) => index > 0 && item.sequence <= value.queue[index - 1].sequence)) return false;
  if (value.queue.some((item) => item.sequence >= value.nextSequence)) return false;
  if (new Set(value.queue.map((item) => item.id)).size !== value.queue.length) return false;
  if (
    value.pause !== undefined &&
    (!value.pause ||
      typeof value.pause !== 'object' ||
      !['failure', 'manual', 'recovered_interrupted'].includes(value.pause.reason))
  )
    return false;
  if (value.active !== undefined) {
    const active = value.active;
    if (
      !active ||
      typeof active !== 'object' ||
      !nonempty(active.executionId) ||
      !queueItem(active.item) ||
      !Object.hasOwn(active, 'snapshot') ||
      !['running', 'awaiting_active_action', 'cancelling', 'completing'].includes(active.phase)
    )
      return false;
    if (
      active.pendingAction !== undefined &&
      (!active.pendingAction ||
        typeof active.pendingAction !== 'object' ||
        !nonempty(active.pendingAction.actionId) ||
        !['tool_approval', 'ask_user'].includes(active.pendingAction.kind))
    )
      return false;
    if (value.queue.some((item) => item.id === active.item.id)) return false;
  }
  return true;
};
const sameStat = (a, b) => ['dev', 'ino', 'mode', 'size', 'mtimeNs', 'ctimeNs'].every((key) => a[key] === b[key]);

/** A queued-work sidecar is owned input, not ignorable auxiliary JSON. */
function queueSidecarStatus(canonical) {
  const queuePath = `${canonical.slice(0, -6)}.queue.json`;
  let before;
  try {
    before = fs.lstatSync(queuePath, { bigint: true });
  } catch (error) {
    return error.code === 'ENOENT' ? 'absent' : 'invalid';
  }
  if (!before.isFile()) return 'invalid';
  let bytes;
  try {
    const fd = fs.openSync(queuePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      if (!sameStat(before, fs.fstatSync(fd, { bigint: true }))) return 'invalid';
      bytes = fs.readFileSync(fd, 'utf8');
      if (!sameStat(before, fs.fstatSync(fd, { bigint: true }))) return 'invalid';
    } finally {
      fs.closeSync(fd);
    }
    if (!sameStat(before, fs.lstatSync(queuePath, { bigint: true }))) return 'invalid';
  } catch {
    return 'invalid';
  }
  let record;
  try {
    record = JSON.parse(bytes);
  } catch {
    return 'invalid';
  }
  if (!validQueueRecord(record)) return 'invalid';
  return record.queue.length ? 'queued' : 'empty';
}
const sourceIdentity = (input) => ({
  canonical: input.source.canonical.sha256,
  deltas: input.source.deltas.status === 'absent' ? null : input.source.deltas.sha256,
});
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function inventory(source) {
  const names = fs.readdirSync(source).sort();
  const canonicals = names.filter((name) => name.endsWith('.jsonl'));
  const paired = new Set(canonicals.map((name) => name.slice(0, -6)));
  const counts = {
    canonical: canonicals.length,
    pairedDeltas: 0,
    pairedJson: 0,
    orphanDeltas: 0,
    orphanJson: 0,
    locks: 0,
    other: 0,
    migrated: 0,
    noop: 0,
    skipped: 0,
    failed: 0,
  };
  for (const name of names) {
    if (name.endsWith('.jsonl')) continue;
    if (name.endsWith('.deltas')) counts[paired.has(name.slice(0, -7)) ? 'pairedDeltas' : 'orphanDeltas']++;
    else if (name.endsWith('.json')) counts[paired.has(name.slice(0, -5)) ? 'pairedJson' : 'orphanJson']++;
    else if (name.endsWith('.lock')) counts.locks++;
    else counts.other++;
  }
  return { canonicals, counts };
}

/**
 * Run against explicit quiescent source COPY, existing native directory and private
 * provenance file. Converter override is solely a temporary synthetic-control seam;
 * production lazily loads the real sibling converter, never a fallback mapping.
 */
export async function runMigration(options, synthetic = {}) {
  const paths = preparePaths(options);
  const { importDirectSession } = await import('../../rewrite/dist/rewrite/src/session/direct-import.js');
  const { acquireDirectWriterLock } = await import('../../rewrite/dist/rewrite/src/session/direct-writer-lock.js');
  const { readDirectLogLineage } = await import('../../rewrite/dist/rewrite/src/session/direct-rolling-log.js');
  const { readV3Conversation } = await import('./v3-input.mjs');
  const release = acquireDirectWriterLock(join(paths.privateDirectory, 'command-authority'));
  let scratch;
  try {
    const state = readProvenance(paths);
    const { canonicals, counts } = inventory(paths.source);
    const codes = {};
    const code = (name) => {
      codes[name] = (codes[name] ?? 0) + 1;
    };
    let convert;
    // A saved pending receipt owns only this exact prefix, not a whole continued file.
    function receiptPresent(record) {
      const target = join(paths.native, `${record.id}.jsonl`);
      try {
        fs.lstatSync(target);
      } catch (error) {
        if (error.code === 'ENOENT') return false;
        throw error;
      }
      const unlock = acquireDirectWriterLock(target);
      try {
        // Native discovery reports raw filenames on unrelated corruption. Suppress
        // that synchronous diagnostic at this private aggregate-only boundary.
        const warn = console.warn;
        let lineage;
        try {
          console.warn = () => {};
          lineage = readDirectLogLineage(paths.native, record.id);
        } finally {
          console.warn = warn;
        }
        if (lineage.logicalSessionId !== record.id || lineage.segments[0]?.throughSeq < record.throughSeq)
          throw new Error('invalid prefix boundary');
        const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try {
          if (!fs.fstatSync(fd).isFile() || fs.fstatSync(fd).size < record.bytes)
            throw new Error('invalid prefix file');
          const prefix = Buffer.alloc(record.bytes);
          let offset = 0;
          while (offset < prefix.length) {
            const n = fs.readSync(fd, prefix, offset, prefix.length - offset, offset);
            if (!n) throw new Error('short prefix');
            offset += n;
          }
          if (sha256(prefix) !== record.sha256 || prefix.at(-1) !== 10) throw new Error('changed prefix');
          // Also closes the post-publication/pre-directory-fsync crash window.
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        syncPath(paths.native);
        return true;
      } finally {
        unlock();
      }
    }
    for (const name of canonicals) {
      const oldId = name.slice(0, -6);
      // Older stores may name the canonical file with the persisted `conv_`
      // prefix.  It is the same UUID identity as the unprefixed legacy form;
      // keep one normalized map/target identity rather than manufacturing
      // `conv_conv_<uuid>`.
      const legacyId = oldId.startsWith('conv_') ? oldId.slice('conv_'.length) : oldId;
      const path = join(paths.source, name);
      let input = readV3Conversation(path);
      if (input.status === 'skipped-locked') {
        counts.skipped++;
        code('SOURCE_LOCKED');
        continue;
      }
      if (input.status !== 'imported-input') {
        counts.failed++;
        code('INPUT_FAILED');
        continue;
      }
      if (!UUID.test(legacyId)) {
        counts.failed++;
        code('UNSUPPORTED_ID');
        continue;
      }
      const refuseQueue = () => {
        const status = queueSidecarStatus(path);
        if (status === 'queued') {
          counts.failed++;
          code('QUEUED_WORK_PRESENT');
          return true;
        }
        if (status === 'invalid') {
          counts.failed++;
          code('QUEUE_SIDECAR_INVALID');
          return true;
        }
        return false;
      };
      if (refuseQueue()) continue;
      const source = sourceIdentity(input);
      let record = state.records[legacyId];
      if (record && !same(record.source, source)) {
        counts.failed++;
        code('SOURCE_CHANGED');
        continue;
      }
      if (!record) {
        let occupied = false;
        try {
          fs.lstatSync(join(paths.native, `conv_${legacyId}.jsonl`));
          occupied = true;
        } catch (error) {
          if (error.code !== 'ENOENT') occupied = true;
        }
        if (occupied) {
          counts.failed++;
          code('FOREIGN_TARGET');
          continue;
        }
      }
      if (record) {
        let present;
        try {
          present = receiptPresent(record);
        } catch {
          counts.failed++;
          code('TARGET_REFUSED');
          continue;
        }
        if (present) {
          // Revalidate even on no-op: locks/source mutations cannot be blessed.
          const check = readV3Conversation(path);
          if (check.status !== 'imported-input' || !same(sourceIdentity(check), source)) {
            counts.failed++;
            code('SOURCE_CHANGED');
            continue;
          }
          if (record.status === 'pending') {
            record.status = 'complete';
            writeProvenance(paths, state);
          }
          counts.noop++;
          code('ALREADY_MIGRATED');
          continue;
        }
        if (record.status === 'complete') {
          counts.failed++;
          code('TARGET_MISSING');
          continue;
        }
      }
      let converted;
      let receipt;
      try {
        convert ??= synthetic.convert ?? (await import('./v3-to-native.mjs')).convertValidatedV3;
        converted = await convert(input);
        if (converted.id !== `conv_${legacyId}`) throw new Error('mismatched ID');
        // Real encoding/replay in private scratch, not a second native encoder.
        scratch = fs.mkdtempSync(join(paths.privateDirectory, '.encode-'));
        const stage = join(scratch, 'native');
        const result = importDirectSession({ directory: stage, id: converted.id, entries: converted.entries });
        const lineage = readDirectLogLineage(stage, converted.id);
        receipt = {
          status: 'pending',
          id: converted.id,
          source,
          bytes: result.bytes,
          sha256: result.sha256,
          throughSeq: lineage.entries.at(-1).seq,
        };
        if (
          record &&
          (record.bytes !== receipt.bytes ||
            record.sha256 !== receipt.sha256 ||
            record.throughSeq !== receipt.throughSeq)
        )
          throw new Error('pending encoding changed');
      } catch {
        counts.failed++;
        code('CONVERSION_FAILED');
        continue;
      } finally {
        if (scratch) {
          fs.rmSync(scratch, { recursive: true, force: true });
          scratch = undefined;
        }
      }
      // Conversion can be long. Do not publish or write provenance if queued
      // ownership appeared while the quiescent-copy precondition was violated.
      if (refuseQueue()) continue;
      // Durable intent precedes real publication. A failed save stops the command.
      state.records[legacyId] = receipt;
      writeProvenance(paths, state);
      input = undefined;
      const check = readV3Conversation(path);
      if (check.status !== 'imported-input' || !same(sourceIdentity(check), source)) {
        counts.failed++;
        code('SOURCE_CHANGED');
        continue;
      }
      try {
        const published = importDirectSession({
          directory: paths.native,
          id: converted.id,
          entries: converted.entries,
        });
        if (published.bytes !== receipt.bytes || published.sha256 !== receipt.sha256)
          throw new Error('publication differs from durable intent');
      } catch {
        counts.failed++;
        code('PUBLICATION_FAILED');
        continue;
      }
      receipt.status = 'complete';
      writeProvenance(paths, state);
      counts.migrated++;
      code('MIGRATED');
    }
    return { counts, codes };
  } finally {
    try {
      if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
    } finally {
      release();
    }
  }
}

/** Strict flags only; no defaults, positional paths, environment or live discovery. */
export function parseMigrationArguments(args) {
  const flags = { '--source-copy': 'sourceCopy', '--destination': 'destination', '--provenance': 'provenance' };
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = Object.hasOwn(flags, args[i]) ? flags[args[i]] : undefined;
    const value = args[i + 1];
    if (!key || options[key] || !value || value.startsWith('--')) throw new Error('invalid arguments');
    options[key] = value;
  }
  if (Object.keys(options).length !== 3) throw new Error('explicit paths required');
  return options;
}
