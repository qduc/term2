import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  decodeLogEnvelope,
  expandSessionFactBatchEnvelope,
  resolveEnvelopeIdentities,
} from '../../rewrite/dist/source/services/conversation/conversation-decoder.js';
import { replayEvents } from '../../rewrite/dist/source/services/conversation/conversation-replay.js';

// The legacy decoder deliberately accepts unknown facts. Migration must not.
const kinds = new Set(
  `session_init session_settings_initialized settings_changed goal_changed
events_retracted context_checkpoint_created context_compaction_recorded user_message
user_input_accepted tool_output_rewound user_turn_retried tool_started tool_result command_message
approval_required approval_resolved openai_root_selector_parity openai_root_checkpoint_lifecycle
assistant_journal_delta assistant_journal_item subagent_started subagent_tool_started
subagent_completed subagent_interrupted subagent_transferred subagent_question
background_shell_started background_shell_completed background_shell_output error assistant_turn
undo session_cleared session_rollover personal_memory_context memory_injected session_fact_batch`.split(/\s+/),
);

class InputFailure extends Error {
  constructor(code, file = 'canonical', line) {
    super(code);
    this.detail = { code, file, ...(line === undefined ? {} : { line }) };
  }
}
const fail = (code, file, line) => {
  throw new InputFailure(code, file, line);
};
const safeId = (id) =>
  typeof id === 'string' &&
  id.length > 0 &&
  id !== '.' &&
  id !== '..' &&
  !id.includes('/') &&
  !id.includes('\\') &&
  [...id].every((char) => char.charCodeAt(0) > 32 && char.charCodeAt(0) !== 127);
const stat = (name) => {
  try {
    return fs.lstatSync(name, { bigint: true });
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
};
const same = (a, b) =>
  a === null
    ? b === null
    : b !== null && ['dev', 'ino', 'mode', 'size', 'mtimeNs', 'ctimeNs'].every((key) => a[key] === b[key]);

function validate(raw, file, line) {
  if (!raw || raw.v !== 3) fail('not-v3', file, line);
  if (
    !Number.isSafeInteger(raw.seq) ||
    raw.seq < 0 ||
    typeof raw.ts !== 'string' ||
    !raw.ts ||
    (raw.logId !== undefined && !safeId(raw.logId)) ||
    (raw.eventId !== undefined && (typeof raw.eventId !== 'string' || !raw.eventId))
  )
    fail('invalid-envelope', file, line);
  if (!raw.event || !kinds.has(raw.event.type)) fail('unknown-event-kind', file, line);
  if (raw.event.truncated === true) fail('truncated-event', file, line);
  let decoded;
  try {
    decoded = decodeLogEnvelope(raw);
  } catch {
    fail('invalid-event', file, line);
  }
  if (!decoded) fail('invalid-event', file, line);
  return decoded;
}

function parse(bytes, file) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    fail('invalid-utf8', file);
  }
  const lines = text.split('\n');
  const entries = [];
  let tornFinalLine = null;
  let previous = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const line = index + 1;
    if (index === lines.length - 1 && lines[index] === '') break;
    let raw;
    try {
      raw = JSON.parse(lines[index]);
    } catch {
      if (index === lines.length - 1 && !text.endsWith('\n')) {
        tornFinalLine = { classification: 'unterminated-invalid-json', line, count: 1 };
        break;
      }
      fail('malformed-json', file, line);
    }
    const outer = validate(raw, file, line);
    let logical = [outer];
    if (outer.event.type === 'session_fact_batch') {
      // A batch is committed by its newline, including syntactically complete tails.
      if (index === lines.length - 1 && !text.endsWith('\n')) {
        tornFinalLine = { classification: 'unterminated-atomic-batch', line, count: 1 };
        break;
      }
      if (!Array.isArray(raw.event.entries)) fail('invalid-batch', file, line);
      for (const member of raw.event.entries) validate(member, file, line);
      try {
        logical = expandSessionFactBatchEnvelope(raw);
      } catch {
        fail('invalid-batch', file, line);
      }
      if (!logical) fail('invalid-batch', file, line);
    }
    for (const entry of logical) {
      if (file === 'deltas' && entry.event.type !== 'assistant_journal_delta')
        fail('non-delta-sidecar-event', file, line);
      if (entry.seq <= previous) fail('invalid-sequence-order', file, line);
      previous = entry.seq;
      entries.push(entry);
    }
  }
  return { entries, tornFinalLine };
}

function readFile(name, before, file) {
  if (!before?.isFile()) fail('nonregular-source', file);
  const fd = fs.openSync(name, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    if (!same(before, fs.fstatSync(fd, { bigint: true }))) fail('source-changed', file);
    const bytes = fs.readFileSync(fd);
    if (!same(before, fs.fstatSync(fd, { bigint: true }))) fail('source-changed', file);
    return {
      bytes,
      metadata: { status: 'read', byteCount: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') },
    };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Read only an explicitly selected old-v3 canonical file and paired .deltas.
 * Return resolved logical envelopes and authoritative reopened legacy replay;
 * failures expose only fixed classifications/line numbers, never source text.
 * No directory creation, source repair, persistence loader, or output facts.
 */
export function readV3Conversation(inputPath) {
  try {
    if (typeof inputPath !== 'string' || !inputPath.endsWith('.jsonl')) fail('invalid-path');
    const canonical = path.resolve(inputPath);
    const id = path.basename(canonical, '.jsonl');
    if (!safeId(id)) fail('invalid-basename');
    const stem = canonical.slice(0, -6);
    const lock = `${stem}.lock`;
    const locked = () => stat(lock) !== null;
    if (locked()) return { status: 'skipped-locked' };
    const deltas = `${stem}.deltas`;
    const before = stat(canonical);
    const deltaBefore = stat(deltas);
    const source = readFile(canonical, before, 'canonical');
    const sidecar = deltaBefore === null ? null : readFile(deltas, deltaBefore, 'deltas');
    if (locked()) return { status: 'skipped-locked' };
    const parsed = parse(source.bytes, 'canonical');
    const deltaParsed = sidecar ? parse(sidecar.bytes, 'deltas') : { entries: [], tornFinalLine: null };
    const ordered = [...parsed.entries, ...deltaParsed.entries].sort((a, b) => a.seq - b.seq);
    const explicitIds = new Set();
    for (const entry of ordered) {
      if (entry.eventId && explicitIds.has(entry.eventId)) fail('duplicate-event-id');
      if (entry.eventId) explicitIds.add(entry.eventId);
    }
    // Forks retain earlier init facts and foreign logIds; the LAST init owns the file.
    const header = ordered.findLast((entry) => entry.event.type === 'session_init');
    if (!header || header.event.id !== id) fail('header-basename-mismatch');
    const envelopes = resolveEnvelopeIdentities(ordered, id, { deduplicateExplicitEventIds: false });
    let restoredState;
    try {
      restoredState = replayEvents(envelopes, { finalization: 'reopened' });
    } catch {
      fail('replay-failed');
    }
    if (locked()) return { status: 'skipped-locked' };
    if (!same(before, stat(canonical)) || !same(deltaBefore, stat(deltas))) fail('source-changed');
    return {
      status: 'imported-input',
      envelopes,
      restoredState,
      source: {
        canonical: { ...source.metadata, tornFinalLine: parsed.tornFinalLine },
        deltas: sidecar ? { ...sidecar.metadata, tornFinalLine: deltaParsed.tornFinalLine } : { status: 'absent' },
        json: { status: stat(`${stem}.json`) === null ? 'absent' : 'ignored-nonauthoritative' },
      },
    };
  } catch (error) {
    return { status: 'failed', error: error instanceof InputFailure ? error.detail : { code: 'source-io-failed' } };
  }
}
