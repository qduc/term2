#!/usr/bin/env node
// Read-only pinned-lineage selector. No resume/list APIs, migration or repair.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, URL } from 'node:url';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import console from 'node:console';

export async function select(config) {
  const { decodeLogEnvelope } = await import(
    pathToFileURL(path.join(path.dirname(config.coordEntry), 'services/conversation/conversation-decoder.js'))
  );
  const safe = (id) => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id);
  const fail = (reason) => {
    throw new Error(reason);
  };
  if (!safe(config.anchor)) fail('Set an explicit persisted-segment anchor');
  const headers = new Map();
  function decode(line) {
    try {
      return decodeLogEnvelope(JSON.parse(line))?.event;
    } catch {
      return null;
    }
  }
  function regular(file) {
    const s = fs.lstatSync(file);
    if (!s.isFile() || s.isSymbolicLink()) fail('Non-regular transcript: ' + path.basename(file));
  }
  // Every canonical header is considered: a corrupt header might hide a child.
  // Sidecars are NOT canonical transcripts and are intentionally not scanned.
  for (const file of fs
    .readdirSync(config.conversations)
    .filter((x) => x.endsWith('.jsonl') && !x.endsWith('.delta.jsonl'))) {
    const id = file.slice(0, -6);
    if (!safe(id)) fail('Unsafe canonical transcript filename');
    const full = path.join(config.conversations, file);
    regular(full);
    const fd = fs.openSync(full, 'r');
    const buf = Buffer.alloc(256 * 1024 + 1);
    let count;
    try {
      count = fs.readSync(fd, buf, 0, buf.length, 0);
    } finally {
      fs.closeSync(fd);
    }
    const text = buf.subarray(0, count).toString('utf8');
    const end = text.indexOf('\n');
    const init = end < 0 ? null : decode(text.slice(0, end));
    if (
      !init ||
      init.type !== 'session_init' ||
      init.id !== id ||
      (init.rolloverFrom !== undefined && !safe(init.rolloverFrom))
    )
      fail('Invalid/unfinished canonical header: ' + id);
    headers.set(id, init);
  }
  // Predecessors of a pinned successor are still referenced history, not optional.
  const ancestors = [config.anchor];
  let parent = headers.get(config.anchor)?.rolloverFrom;
  while (parent !== undefined) {
    if (ancestors.includes(parent)) fail('Lineage ancestor cycle');
    ancestors.push(parent);
    const h = headers.get(parent);
    if (!h || h.projectPath !== config.cwd || h.sshHost) fail('Missing/mismatched referenced predecessor: ' + parent);
    parent = h.rolloverFrom;
  }
  const chain = [];
  let id = ancestors.at(-1);
  while (true) {
    const init = headers.get(id);
    if (!init) fail('Missing lineage segment: ' + id);
    if (chain.includes(id)) fail('Lineage cycle');
    if (init.projectPath !== config.cwd || init.sshHost) fail('Lineage project/host mismatch: ' + id);
    chain.push(id);
    const children = [...headers].filter(([, h]) => h.rolloverFrom === id).map(([key]) => key);
    if (children.length > 1) fail('Ambiguous rollover children: ' + id);
    if (!children.length) break;
    id = children[0];
  }
  if (!chain.includes(config.anchor)) fail('Pinned anchor is not on the resolved lineage');
  const events = new Map();
  for (const key of chain) {
    const text = fs.readFileSync(path.join(config.conversations, key + '.jsonl'), 'utf8');
    const lines = text.split('\n');
    const list = [];
    for (let n = 0; n < lines.length; n++) {
      if (!lines[n].trim()) continue;
      const e = decode(lines[n]);
      // Deliberately stricter than replay: a damaged record may hide lineage
      // metadata. Its position must not change the policy after writer resume.
      // Never skip/repair it, even at EOF; refuse BEFORE launching anything.
      if (!e)
        fail(
          'Undecodable canonical record in lineage: ' +
            key +
            ':' +
            (n + 1) +
            '; manual reconciliation required (automatic corrupt-log recovery is unsupported)',
        );
      if (e.truncated && ['session_init', 'session_cleared', 'session_rollover'].includes(e.type))
        fail('Truncated lineage metadata: ' + key);
      if (e.type === 'session_rollover' && e.phase !== 'completed' && e.sourceSessionId !== key)
        fail('Conflicting rollover source: ' + key);
      if (
        e.type === 'session_init' &&
        (e.id !== key || e.projectPath !== config.cwd || e.sshHost || e.rolloverFrom !== headers.get(key).rolloverFrom)
      )
        fail('Conflicting session initialization: ' + key);
      list.push(e);
    }
    events.set(key, list);
  }
  for (let n = 0; n < chain.length; n++) {
    const key = chain[n],
      next = chain[n + 1],
      list = events.get(key);
    const requested = list.filter((e) => e.type === 'session_rollover' && e.phase === 'requested');
    const completedHere = list.filter((e) => e.type === 'session_rollover' && e.phase === 'completed');
    for (const e of completedHere) {
      if (e.successorSessionId !== key || headers.get(key).rolloverFrom !== e.sourceSessionId)
        fail('Conflicting rollover completion: ' + key);
    }
    for (const r of requested) {
      const blocked = list.some(
        (e) => e.type === 'session_rollover' && e.phase === 'blocked' && e.rolloverId === r.rolloverId,
      );
      const completed =
        next &&
        events
          .get(next)
          .some(
            (e) =>
              e.type === 'session_rollover' &&
              e.phase === 'completed' &&
              e.rolloverId === r.rolloverId &&
              e.sourceSessionId === key &&
              e.successorSessionId === next,
          );
      if (!blocked && !completed) fail('Unfinished rollover: ' + key);
    }
    if (next) {
      const commits = events
        .get(next)
        .filter(
          (e) =>
            e.type === 'session_rollover' &&
            e.phase === 'completed' &&
            e.sourceSessionId === key &&
            e.successorSessionId === next &&
            requested.some((r) => r.rolloverId === e.rolloverId),
        );
      if (commits.length !== 1 || !list.some((e) => e.type === 'session_cleared'))
        fail('Uncommitted rollover edge: ' + key);
    } else if (list.some((e) => e.type === 'session_cleared'))
      fail('Cleared/switching leaf: explicitly repin before recovery');
  }
  return { leaf: chain.at(-1), chain, logPath: path.join(config.conversations, chain.at(-1) + '.jsonl') };
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  try {
    console.log(JSON.stringify(await select(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')))));
  } catch (e) {
    console.error('lineage:', e.message);
    process.exitCode = 1;
  }
}
