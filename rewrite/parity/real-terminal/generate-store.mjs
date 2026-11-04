#!/usr/bin/env node
// Synthetic conversation store for the real-terminal check. Nothing here is copied from a real conversation:
// each CLI first writes small template conversations against the loopback fake provider (lib/record-templates),
// and this script clones those blocks with fresh ids, times and seq numbers, so every line keeps the exact shape
// that CLI writes (including how each CLI caps and references a large tool output).
//
//   node rewrite/parity/real-terminal/generate-store.mjs --out <dir> [--size-mb 420] [--seed 7]
//
// Both formats are written in lockstep from one seeded plan (same session ids, projects, times and turns), so
// each CLI sees the same conversations; generation stops once every format has at least --size-mb.
//
// Output:
//   <dir>/conversations/        legacy logs (*.jsonl, *.queue.json, last.json)
//   <dir>/conversations-next/   term2-next logs (conv_*.jsonl, conv_locks/)
//                               the same names both CLIs use under their data dir; each reaches --size-mb on its own
//   <dir>/workspace/       the project most sessions belong to; run.mjs uses it as the CLIs' cwd
//   <dir>/manifest.json    what was generated
//
// The store holds many sessions of mixed length plus one long session with large tool outputs, repeated
// compactions and one reply of 200,000 streamed deltas.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { recordTemplates, SMALL_FILE, LARGE_FILE, DELTA_COUNT, deltaToken } from './lib/record-templates.mjs';

const MB = 1024 * 1024;
const LONG_DELTAS = 200_000;

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g;
const TURN = /turn-(\d+)/g;
const CALL = /call_(\d+)_(\d+)/g;

/** Per-format knowledge, all of it read off the recorded templates. */
const FORMATS = {
  legacy: {
    payload: (record) => record.event,
    sessionId: (header) => header.event.id,
    blockStart: (type) => type === 'user_message' || type === 'context_checkpoint_created',
    isCompaction: (block) => block.types.includes('context_checkpoint_created'),
    fileName: (id) => `${id}.jsonl`,
  },
  next: {
    payload: (record) => record.fact,
    sessionId: (header) => header.fact.id.replace(/^conv_/, ''),
    blockStart: (type) => type === 'queue_submitted' || type === 'command_started',
    isCompaction: (block) => block.types.includes('history_replaced'),
    fileName: (id) => `conv_${id}.jsonl`,
  },
};

function rng(seed) {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

function uuidFrom(random) {
  const hex = Array.from({ length: 32 }, () => Math.floor(random() * 16).toString(16)).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
}

const WORDS = (
  'buffer render session cache index stream token module export import value handler request response ' +
  'config parser layout widget terminal provider compact history append fsync worker queue retry approval'
).split(' ');

function loadTemplate(dir, format) {
  dir = typeof dir === 'string' ? dir : dir.long;
  const file = fs.readdirSync(dir).find((name) => name.endsWith('.jsonl'));
  if (!file) throw new Error(`template recording wrote no conversation log in ${dir}`);
  const lines = fs.readFileSync(path.join(dir, file), 'utf8').trim().split('\n');
  const records = lines.map((raw) => ({ raw, json: JSON.parse(raw) }));
  const header = records[0];
  const sessionId = FORMATS[format].sessionId(header.json);
  const blocks = [];
  for (const record of records.slice(1)) {
    const type = FORMATS[format].payload(record.json).type;
    if (FORMATS[format].blockStart(type) || blocks.length === 0) blocks.push({ records: [], types: [] });
    blocks.at(-1).records.push(record);
    blocks.at(-1).types.push(type);
  }
  for (const block of blocks) {
    const raw = block.records.map((record) => record.raw).join('\n');
    block.kind = FORMATS[format].isCompaction(block)
      ? 'compaction'
      : raw.includes(`cat ${LARGE_FILE}`)
      ? 'tool-large'
      : raw.includes(`cat ${SMALL_FILE}`)
      ? 'tool-small'
      : raw.includes(deltaToken(DELTA_COUNT - 1).trim())
      ? 'delta'
      : 'plain';
  }
  const sidecars = fs
    .readdirSync(dir)
    .filter((name) => name !== file && name !== 'last.json' && fs.statSync(path.join(dir, name)).isFile());
  const root = path.dirname(dir);
  const startMs = Date.parse(header.json.ts ?? header.json.at);
  return { format, dir, header, blocks, sessionId, root, workspace: path.join(root, 'work'), startMs, sidecars };
}

/** Writes one session file by replaying template blocks with fresh identities, times and sizes. */
class SessionWriter {
  constructor({ format, template, file, sessionId, project, startMs, random }) {
    Object.assign(this, { format, template, sessionId, project, random });
    // Same length as the recording root: term2-next references slices of tool output by offset, and that output
    // names the CLI's saved full-output file under the recording home.
    const len = template.root.length;
    this.homeStandIn = `/home/rt-user${'/r'.repeat(len)}`.slice(0, len);
    this.fd = fs.openSync(file, 'w');
    this.bytes = 0;
    this.seq = 0;
    this.turn = 0;
    this.block = 0;
    this.timeMs = startMs;
    this.chunks = [];
    this.pending = 0;
    this.emit([template.header], { header: true });
  }

  rewrite(raw, ctx) {
    const t = this.template;
    // Paths become placeholders first: a recording path can itself contain a UUID-shaped segment.
    return raw
      .replaceAll(t.workspace, '\u0001W')
      .replaceAll(t.root, '\u0001R')
      .replaceAll(t.sessionId, this.sessionId)
      .replace(UUID, (id) => {
        if (id === this.sessionId) return id;
        if (!ctx.uuids.has(id)) ctx.uuids.set(id, uuidFrom(this.random));
        return ctx.uuids.get(id);
      })
      .replace(TURN, (_, n) => `turn-${ctx.turnBase + Number(n)}`)
      .replace(CALL, (_, n, i) => `call_${this.block}_${n}_${i}`)
      .replace(ISO, (stamp) => new Date(Date.parse(stamp) - ctx.templateMs + this.timeMs).toISOString())
      .replaceAll('\u0001W', this.project)
      .replaceAll('\u0001R', this.homeStandIn);
  }

  emit(records, { header = false, deltas = 0 } = {}) {
    const ctx = {
      uuids: new Map(),
      turnBase: this.turn,
      templateMs: Date.parse(records[0].json.ts ?? records[0].json.at),
    };
    if (header) {
      this.write(this.rewrite(records[0].raw, ctx));
      this.seq = records[0].json.seq;
      return;
    }
    // Pass 1: new seq for every template seq. Gaps inside a block are kept (legacy spends seqs on records it
    // never writes); a block starts right after the previous one. Expanded deltas push later records down.
    const firstSeq = records[0].json.seq;
    const seqMap = new Map();
    let shift = 0;
    const plan = [];
    for (const record of records) {
      const seq = this.seq + 1 + (record.json.seq - firstSeq) + shift;
      seqMap.set(record.json.seq, seq);
      if (deltas && isSingleDelta(record.raw)) {
        if (!record.raw.includes(deltaToken(0))) {
          shift -= 1; // the first template delta stands for all of them
          continue;
        }
        plan.push({ record, seq, expand: deltas });
        shift += deltas - 1;
        continue;
      }
      const joined = deltas && record.raw.includes(joinedTemplate());
      if (joined && this.format === 'legacy') {
        // Legacy keeps no per-delta records but still spends one seq per delta.
        shift += deltas - DELTA_COUNT;
        seqMap.set(record.json.seq, seq + deltas - DELTA_COUNT);
        plan.push({ record, seq: seq + deltas - DELTA_COUNT, joined });
        continue;
      }
      plan.push({ record, seq, joined });
    }
    // Pass 2: write, pointing same-turn references (term2-next `refs[].source.seq`) at the new seqs.
    let maxTurn = 0;
    for (const { record, seq, expand, joined } of plan) {
      for (const match of record.raw.matchAll(TURN)) maxTurn = Math.max(maxTurn, Number(match[1]));
      let raw = withSeq(this.rewrite(record.raw, ctx), seq).replace(
        /"source":\{"seq":(\d+)/g,
        (whole, old) => (seqMap.has(Number(old)) ? `"source":{"seq":${seqMap.get(Number(old))}` : whole),
      );
      if (joined) raw = raw.replace(joinedTemplate(), joinedTokens(deltas));
      if (expand) {
        for (let i = 0; i < expand; i++) this.write(withSeq(raw.replace(deltaToken(0), deltaToken(i)), seq + i));
      } else {
        this.write(raw);
      }
    }
    this.seq = this.seq + 1 + (records.at(-1).json.seq - firstSeq) + shift;
    this.turn += maxTurn;
    this.block += 1;
    this.timeMs += 40_000 + Math.floor(this.random() * 400_000);
  }

  write(line) {
    this.chunks.push(line, '\n');
    this.pending += line.length + 1;
    this.bytes += Buffer.byteLength(line) + 1;
    if (this.pending > 4 * MB) this.flush();
  }

  flush() {
    if (this.chunks.length) fs.writeSync(this.fd, this.chunks.join(''));
    this.chunks = [];
    this.pending = 0;
  }

  close() {
    this.flush();
    fs.closeSync(this.fd);
    return { bytes: this.bytes, updatedMs: this.timeMs };
  }
}

const joinedTemplate = () => Array.from({ length: DELTA_COUNT }, (_, i) => deltaToken(i)).join('');
const joinedTokens = (n) => {
  const parts = new Array(n);
  for (let i = 0; i < n; i++) parts[i] = deltaToken(i);
  return parts.join('');
};
const isSingleDelta = (raw) => (raw.match(/rtd\d{6} /g) ?? []).length === 1;
const withSeq = (raw, seq) => raw.replace(/^\{"v":(\d+),"seq":\d+,/, `{"v":$1,"seq":${seq},`);

/** One session in every format at once, from one seeded plan: same id, project, times and block sequence. */
function writeSessions(ctx, { templates, project, startMs, seed, kind, steps }) {
  const id = uuidFrom(rng(seed));
  const writers = Object.fromEntries(
    Object.entries(templates).map(([format, template]) => [
      format,
      new SessionWriter({
        format,
        template,
        file: path.join(ctx.dirs[format], FORMATS[format].fileName(id)),
        sessionId: id,
        project,
        startMs,
        random: rng(seed + 1),
      }),
    ]),
  );
  for (const step of steps(Object.values(writers))) {
    for (const [format, writer] of Object.entries(writers)) {
      writer.emit(templates[format].blocks[step.kind].records, step);
    }
  }
  const out = {};
  for (const [format, writer] of Object.entries(writers)) {
    const { bytes, updatedMs } = writer.close();
    const template = templates[format];
    for (const sidecar of template.sidecars) {
      fs.copyFileSync(path.join(template.dir, sidecar), path.join(ctx.dirs[format], sidecar.replace(template.sessionId, id)));
    }
    if (format === 'next') {
      fs.mkdirSync(path.join(ctx.dirs.next, 'conv_locks'), { recursive: true });
      fs.writeFileSync(path.join(ctx.dirs.next, 'conv_locks', `${FORMATS.next.fileName(id)}.sqlite`), '');
    }
    out[format] = { id: format === 'next' ? `conv_${id}` : id, bytes, updatedMs, project, kind };
  }
  return out;
}

function byKind(template) {
  const blocks = {};
  for (const kind of ['tool-small', 'tool-large', 'plain', 'delta', 'compaction']) {
    const found = template.blocks.find((block) => block.kind === kind);
    if (!found) throw new Error(`${template.format} template has no ${kind} block (kinds: ${template.blocks.map((b) => b.kind)})`);
    blocks[kind] = found;
  }
  return { ...template, blocks };
}

function generate(ctx, templates) {
  const budget = ctx.sizeMb * MB;
  const sessions = Object.fromEntries(Object.keys(templates).map((format) => [format, []]));
  const totals = Object.fromEntries(Object.keys(templates).map((format) => [format, 0]));
  const add = (written) => {
    for (const [format, session] of Object.entries(written)) {
      sessions[format].push(session);
      totals[format] += session.bytes;
    }
  };
  const smallest = () => Math.min(...Object.values(totals));
  const now = Date.parse('2026-10-30T12:00:00.000Z');

  // The long session: ~30% of the budget in the most compact format, mostly capped-large tool outputs, a
  // compaction every 40 blocks, and one reply of 200k streamed deltas.
  const longTarget = Math.floor(budget * 0.3);
  add(
    writeSessions(ctx, {
      templates,
      project: ctx.workspace,
      startMs: now - 20 * 86_400_000,
      seed: Math.floor(ctx.random() * 2 ** 31),
      kind: 'long',
      steps: function* (writers) {
        for (let n = 1; Math.min(...writers.map((w) => w.bytes)) < longTarget; n++) {
          if (n === 60) yield { kind: 'delta', deltas: LONG_DELTAS };
          else if (n % 40 === 0) yield { kind: 'compaction' };
          else if (n % 3 === 0) yield { kind: 'plain' };
          else yield { kind: ctx.random() < 0.8 ? 'tool-large' : 'tool-small' };
        }
      },
    }),
  );

  // Many ordinary sessions: 1-40 blocks, 40% in other (possibly deleted) projects, until every format has
  // reached the budget.
  while (smallest() < budget) {
    const blocks = 1 + Math.floor(ctx.random() ** 2 * 40);
    const project =
      ctx.random() < 0.6 ? ctx.workspace : `/home/rt-user/projects/${WORDS[Math.floor(ctx.random() * WORDS.length)]}-app`;
    const kinds = Array.from({ length: blocks }, () => {
      const roll = ctx.random();
      return roll < 0.35 ? 'tool-small' : roll < 0.5 ? 'tool-large' : roll < 0.97 ? 'plain' : 'compaction';
    });
    add(
      writeSessions(ctx, {
        templates,
        project,
        startMs: now - Math.floor(ctx.random() * 180 * 86_400_000),
        seed: Math.floor(ctx.random() * 2 ** 31),
        kind: 'ordinary',
        steps: function* () {
          for (const kind of kinds) yield { kind };
        },
      }),
    );
  }
  return { sessions, totals };
}

async function main() {
  const { values } = parseArgs({
    options: {
      out: { type: 'string' },
      'size-mb': { type: 'string', default: '420' },
      seed: { type: 'string', default: '7' },
      only: { type: 'string' },
    },
  });
  if (!values.out) throw new Error('usage: generate-store.mjs --out <dir> [--size-mb 420] [--seed 7]');
  const out = path.resolve(values.out);
  if (fs.existsSync(out) && fs.readdirSync(out).length) throw new Error(`${out} is not empty`);
  const dirs = { legacy: path.join(out, 'conversations'), next: path.join(out, 'conversations-next') };
  const workspace = path.join(out, 'workspace');
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-templates-'));
  const ctx = { dirs, workspace, sizeMb: Number(values['size-mb']), random: rng(Number(values.seed)) };
  const manifest = { generatedAt: new Date().toISOString(), seed: Number(values.seed), minimumMbPerFormat: ctx.sizeMb, formats: {} };
  try {
    const templates = {};
    for (const format of values.only ? [values.only] : ['legacy', 'next']) {
      process.stderr.write(`[store] recording ${format} templates\n`);
      const recorded = await recordTemplates(format, scratch);
      templates[format] = byKind(loadTemplate(recorded, format));
    }
    process.stderr.write('[store] generating\n');
    const { sessions, totals } = generate(ctx, templates);
    if (sessions.legacy) {
      // The legacy CLI's own index of recent sessions, newest first.
      const entries = [...sessions.legacy]
        .sort((a, b) => b.updatedMs - a.updatedMs)
        .map((s) => ({ id: s.id, updatedAt: new Date(s.updatedMs).toISOString(), projectPath: s.project }));
      fs.writeFileSync(path.join(dirs.legacy, 'last.json'), JSON.stringify({ entries }, null, 2));
    }
    for (const [format, list] of Object.entries(sessions)) {
      const long = list.find((s) => s.kind === 'long');
      manifest.formats[format] = {
        directory: path.basename(dirs[format]),
        sessions: list.length,
        bytes: totals[format],
        longSession: { id: long.id, bytes: long.bytes, deltas: LONG_DELTAS },
      };
      process.stderr.write(`[store] ${format}: ${list.length} sessions, ${(totals[format] / MB).toFixed(0)} MB\n`);
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  seedWorkspace(workspace);
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify(manifest, null, 2));
}

function seedWorkspace(workspace) {
  fs.writeFileSync(path.join(workspace, 'README.md'), '# demo project\n\nA small workspace for the parity walk.\n');
  fs.writeFileSync(
    path.join(workspace, 'notes.txt'),
    Array.from({ length: 40 }, (_, i) => `line ${i + 1}: the quick brown fox`).join('\n') + '\n',
  );
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'src', 'main.js'), "export function main() {\n  return 'hello';\n}\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
