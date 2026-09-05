/**
 * M0 synthetic corpus generator and canonical-session-browser benchmark.
 *
 * This deliberately writes only deterministic synthetic text.  Keep its output
 * outside the repository (the default is /tmp) so no user transcript can be
 * accidentally staged.
 *
 * Examples:
 *   pnpm exec tsx scripts/session-query-index-m0.ts generate --size 100 --out /tmp/sqi-m0-100
 *   pnpm exec tsx scripts/session-query-index-m0.ts benchmark --corpus /tmp/sqi-m0-100 --samples 5
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

type Args = Record<string, string | boolean>;
type Operation = { name: string; run: () => unknown };
type Measurement = {
  name: string;
  condition: 'missing_index';
  samples: number;
  p50Ms: number;
  p95Ms: number;
  transcriptReplayCount: number;
  transcriptReplayBytes: number;
  metadataChecks: number;
  peakRssBytes: number;
  eventLoopDelayP95Ms: number | null;
};

const PROJECT = '/synthetic/session-query-index-m0';
const DEFAULT_OUT = path.join(os.tmpdir(), 'session-query-index-m0');
const TAIL_ID = '00000000-0000-4000-8000-00000000ffff';
const TAIL_FACT = 'TAIL_FACT_RECOVERABLE_BEFORE_FINAL_RECORD';
const TAIL_FINAL = 'TAIL_FINAL_RECORD_ANCHOR';

function args(argv: string[]): Args {
  const result: Args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]!;
    if (!value.startsWith('--')) throw new Error(`Unexpected argument: ${value}`);
    const key = value.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) result[key] = true;
    else {
      result[key] = next;
      index += 1;
    }
  }
  return result;
}

function required(input: Args, name: string): string {
  const value = input[name];
  if (typeof value !== 'string' || !value) throw new Error(`--${name} is required`);
  return value;
}

function numeric(input: Args, name: string, fallback: number): number {
  const value = input[name];
  const parsed = typeof value === 'string' ? Number(value) : fallback;
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`--${name} must be a positive integer`);
  return parsed;
}

function idFor(index: number): string {
  // The browser's short-reference generator is quadratic in UUID population.
  // Keep one UUID target for exact/prefix/previous resolution, but make bulk
  // corpus IDs safe non-UUID values so this benchmark measures replay/search
  // scale rather than an unrelated reference-collision algorithm.
  return index === 16 ? '00000010-0000-4000-8000-000000000000' : `synthetic-${index}`;
}

function envelope(seq: number, event: unknown, index: number) {
  return JSON.stringify({ v: 3, seq, ts: `2026-01-01T00:${String(index % 60).padStart(2, '0')}:00.000Z`, event });
}

function textFor(index: number, record: number): string {
  const tier = index % 3;
  const chars = tier === 0 ? 96 : tier === 1 ? 384 : 1_536;
  const token = index === 17 && record === 0 ? ' SELECTIVE_NEEDLE_17 ' : '';
  return (`common broad corpus text session ${index} record ${record} prefixable continuation ` + token)
    .repeat(Math.ceil(chars / 80))
    .slice(0, chars);
}

function sessionLines(id: string, index: number, rolloverFrom?: string): string[] {
  const lines = [
    envelope(
      1,
      {
        type: 'session_init',
        id,
        createdAt: '2026-01-01T00:00:00.000Z',
        projectPath: PROJECT,
        model: 'synthetic',
        provider: 'none',
        rolloverFrom,
      },
      index,
    ),
  ];
  const pairs = index % 3 === 0 ? 2 : index % 3 === 1 ? 6 : 12;
  let seq = 2;
  for (let record = 0; record < pairs; record += 1) {
    lines.push(
      envelope(
        seq++,
        { type: 'user_message', message: { id: `${id}-u${record}`, sender: 'user', text: textFor(index, record) } },
        index,
      ),
    );
    lines.push(
      envelope(
        seq++,
        {
          type: 'assistant_turn',
          turn: { items: [{ type: 'assistant_text', text: textFor(index, record) }] },
          state: { previousResponseId: null },
        },
        index,
      ),
    );
  }
  return lines;
}

function generate(out: string, size: number) {
  if (![100, 1_000, 10_000].includes(size)) throw new Error('--size must be one of 100, 1000, 10000');
  if (new Set(Array.from({ length: size }, (_, index) => idFor(index))).size !== size)
    throw new Error('Synthetic corpus IDs must be unique.');
  const conversations = path.join(out, 'conversations');
  fs.mkdirSync(conversations, { recursive: true });
  let bytes = 0;
  let projectedRecords = 0;
  for (let index = 0; index < size; index += 1) {
    const id = idFor(index);
    const rolloverFrom = index === size - 1 ? idFor(16) : undefined;
    const content = `${sessionLines(id, index, rolloverFrom).join('\n')}\n`;
    fs.writeFileSync(path.join(conversations, `${id}.jsonl`), content);
    bytes += Buffer.byteLength(content);
    projectedRecords += (index % 3 === 0 ? 2 : index % 3 === 1 ? 6 : 12) * 2;
  }
  const tailLines = [
    envelope(
      1,
      {
        type: 'session_init',
        id: TAIL_ID,
        createdAt: '2026-01-02T00:00:00.000Z',
        projectPath: PROJECT,
        model: 'synthetic',
        provider: 'none',
      },
      0,
    ),
    envelope(
      2,
      { type: 'user_message', message: { id: 'tail-user', sender: 'user', text: 'tail fixture request' } },
      0,
    ),
    envelope(
      3,
      {
        type: 'assistant_turn',
        turn: { items: [{ type: 'assistant_text', text: TAIL_FACT }] },
        state: { previousResponseId: null },
      },
      0,
    ),
    envelope(
      4,
      {
        type: 'assistant_turn',
        turn: { items: [{ type: 'assistant_text', text: TAIL_FINAL }] },
        state: { previousResponseId: null },
      },
      0,
    ),
  ];
  const tailContent = `${tailLines.join('\n')}\n`;
  fs.writeFileSync(path.join(conversations, `${TAIL_ID}.jsonl`), tailContent);
  bytes += Buffer.byteLength(tailContent);
  projectedRecords += 3;
  const manifest = {
    version: 1,
    generator: 'scripts/session-query-index-m0.ts',
    corpus: {
      sessions: size + 1,
      requestedSessions: size,
      aggregateBytes: bytes,
      projectedRecords,
      variedPairs: [2, 6, 12],
    },
    projectPath: PROJECT,
    tailFixture: {
      id: TAIL_ID,
      fact: TAIL_FACT,
      finalRecord: TAIL_FINAL,
      semantics: 'pre-repair (final-record anchor)',
    },
  };
  fs.writeFileSync(path.join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(manifest)}\n`);
}

function percentile(values: number[], percentileValue: number): number {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.max(0, Math.ceil((percentileValue / 100) * ordered.length) - 1)] ?? 0;
}

async function benchmark(corpus: string, samples: number) {
  const manifest = JSON.parse(fs.readFileSync(path.join(corpus, 'manifest.json'), 'utf8')) as {
    projectPath: string;
    tailFixture: { id: string; fact: string; finalRecord: string };
  };
  process.env.TERM2_CONVERSATIONS_DIR = path.join(corpus, 'conversations');
  const { SessionBrowser } = await import('../source/services/conversation/session-browser.js');
  const currentId = idFor(
    Number(fs.readdirSync(process.env.TERM2_CONVERSATIONS_DIR).filter((file) => file.endsWith('.jsonl')).length) - 2,
  );
  const browser = () => new SessionBrowser(() => ({ projectPath: manifest.projectPath, currentSessionId: currentId }));
  const targetId = idFor(16);
  const operations: Operation[] = [
    { name: 'list', run: () => browser().list({ limit: 10 }) },
    { name: 'search_selective', run: () => browser().search({ query: 'SELECTIVE_NEEDLE_17', limit: 10 }) },
    { name: 'search_broad', run: () => browser().search({ query: 'common broad', limit: 10 }) },
    { name: 'search_short_term', run: () => browser().search({ query: 'co', limit: 10 }) },
    { name: 'read_exact_initial', run: () => browser().read({ id: targetId, limit: 10 }) },
    { name: 'read_prefix_initial', run: () => browser().read({ id: targetId.slice(0, 35), limit: 10 }) },
    { name: 'read_previous_initial', run: () => browser().read({ id: 'previous', limit: 10 }) },
    {
      name: 'read_tail_pre_repair_final_record_anchor',
      run: () => browser().read({ id: manifest.tailFixture.id, from: 'end', limit: 10 }),
    },
    {
      name: 'read_continuation',
      run: () => {
        const instance = browser();
        const first = instance.read({ id: targetId, maxChars: 512 }) as { nextCursor?: string };
        return first.nextCursor ? instance.read({ id: targetId, cursor: first.nextCursor, maxChars: 512 }) : first;
      },
    },
  ];
  const originalRead = fs.readFileSync;
  const originalReaddir = fs.readdirSync;
  const results: Measurement[] = [];
  for (const operation of operations) {
    const durations: number[] = [];
    let replayCount = 0;
    let replayBytes = 0;
    let metadataChecks = 0;
    let peakRssBytes = process.memoryUsage().rss;
    const eventLoopDelays: number[] = [];
    for (let sample = 0; sample < samples; sample += 1) {
      fs.readFileSync = ((
        file: fs.PathOrFileDescriptor,
        ...rest: Parameters<typeof fs.readFileSync> extends [any, ...infer R] ? R : never[]
      ) => {
        const result = originalRead(file as never, ...(rest as never));
        if (typeof file === 'string' && file.endsWith('.jsonl')) {
          replayCount += 1;
          replayBytes += Buffer.isBuffer(result) ? result.length : Buffer.byteLength(String(result));
        }
        return result;
      }) as typeof fs.readFileSync;
      fs.readdirSync = ((...readArgs: Parameters<typeof fs.readdirSync>) => {
        metadataChecks += 1;
        return originalReaddir(...readArgs);
      }) as typeof fs.readdirSync;
      const scheduledAt = performance.now();
      const tick = new Promise<void>((resolve) =>
        setImmediate(() => {
          eventLoopDelays.push(performance.now() - scheduledAt);
          resolve();
        }),
      );
      const start = performance.now();
      operation.run();
      durations.push(performance.now() - start);
      fs.readFileSync = originalRead;
      fs.readdirSync = originalReaddir;
      await tick;
      peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
    }
    results.push({
      name: operation.name,
      condition: 'missing_index',
      samples,
      p50Ms: percentile(durations, 50),
      p95Ms: percentile(durations, 95),
      transcriptReplayCount: replayCount,
      transcriptReplayBytes: replayBytes,
      metadataChecks,
      peakRssBytes,
      eventLoopDelayP95Ms: percentile(eventLoopDelays, 95),
    });
  }
  const tail = browser().read({ id: manifest.tailFixture.id, from: 'end', limit: 10 }) as {
    items?: Array<{ text?: string }>;
  };
  const report = {
    version: 1,
    machine: { hostname: os.hostname(), platform: process.platform, arch: process.arch, node: process.version },
    corpus,
    conditionStatus: {
      missing_index: 'measured',
      existing_index_after_restart: 'deferred: index not implemented',
      warm_unchanged: 'deferred: index not implemented',
      one_changed_session: 'deferred: index not implemented',
    },
    measurements: results,
    tailFixture: {
      semantics: 'pre-repair (final-record anchor)',
      recoveredContent: tail.items?.map((item) => item.text).join('\n') ?? null,
      recoveredNeededFact: tail.items?.some((item) => item.text?.includes(manifest.tailFixture.fact)) ?? false,
      pageCount: 1,
      expectedNeededFact: manifest.tailFixture.fact,
    },
    telemetry: { queryTextLogged: false, messageTextLogged: false },
  };
  fs.writeFileSync(path.join(corpus, 'benchmark.json'), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const input = args(rest);
  if (command === 'generate')
    return generate(path.resolve(typeof input.out === 'string' ? input.out : DEFAULT_OUT), numeric(input, 'size', 100));
  if (command === 'benchmark') return benchmark(path.resolve(required(input, 'corpus')), numeric(input, 'samples', 5));
  throw new Error('Usage: generate --size 100|1000|10000 --out DIR | benchmark --corpus DIR [--samples N]');
}

void main();
