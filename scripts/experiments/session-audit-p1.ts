/**
 * P1 read-only viability sample for saved-session audit.
 *
 * This deliberately does not use `auditConversation`: that public facade calls
 * persistence initialization, which may run legacy migration. Keeping the
 * experiment's file reads here makes its non-mutating boundary explicit.
 * Output is aggregate-only; do not add names, IDs, event payloads, or errors.
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  decodeLogEnvelope,
  type PersistedLogEnvelope,
} from '../../source/services/conversation/conversation-decoder.js';
import { auditSessionLog, type SessionOutcome } from '../../source/services/conversation/session-audit.js';
import { deltaSidecarPathFor } from '../../source/services/logging/conversation-log-events.js';

const CONVERSATIONS_DIR = '/home/qduc/.local/share/term2-nodejs/conversations';
const SAMPLE_SIZE = 20;
const outcomes: SessionOutcome[] = [
  'empty',
  'settled',
  'awaiting_approval',
  'interrupted_mid_tool',
  'interrupted_mid_turn',
];

interface DecodeResult {
  readonly envelopes: PersistedLogEnvelope[];
  readonly nonEmptyLines: number;
  readonly skippedLines: number;
}

function decodeFile(filePath: string): DecodeResult {
  const envelopes: PersistedLogEnvelope[] = [];
  let nonEmptyLines = 0;
  let skippedLines = 0;

  for (const line of fs.readFileSync(filePath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    nonEmptyLines++;
    try {
      const envelope = decodeLogEnvelope(JSON.parse(trimmed) as unknown);
      if (envelope) {
        envelopes.push(envelope);
      } else {
        skippedLines++;
      }
    } catch {
      skippedLines++;
    }
  }

  return { envelopes, nonEmptyLines, skippedLines };
}

const startedAt = process.hrtime.bigint();
const candidates: Array<{ filePath: string; modifiedAt: number }> = [];
let directoryReadFailures = 0;
let candidateStatFailures = 0;
try {
  for (const entry of fs.readdirSync(CONVERSATIONS_DIR)) {
    if (!entry.endsWith('.jsonl')) continue;
    try {
      const filePath = path.join(CONVERSATIONS_DIR, entry);
      candidates.push({ filePath, modifiedAt: fs.statSync(filePath).mtimeMs });
    } catch {
      // Do not expose a path when a writer races enumeration or stat.
      candidateStatFailures++;
    }
  }
} catch {
  // Output remains aggregate-only even when the target directory is unavailable.
  directoryReadFailures++;
}
const sample = candidates.sort((a, b) => b.modifiedAt - a.modifiedAt).slice(0, SAMPLE_SIZE);

const outcomeCounts = Object.fromEntries(outcomes.map((outcome) => [outcome, 0])) as Record<SessionOutcome, number>;
let classified = 0;
let unclassifiable = 0;
let primaryReadFailures = 0;
let sidecarReadFailures = 0;
let sidecarsFound = 0;
let filesWithSkippedLines = 0;
let skippedLines = 0;
let totalEnvelopes = 0;
let userTurns = 0;
let assistantTurns = 0;
let toolStarted = 0;
let toolCompleted = 0;
let toolFailed = 0;
let toolAborted = 0;
let toolUnknown = 0;
let unfinishedToolCalls = 0;
let unfinishedSubagents = 0;
let unfinishedBackgroundShells = 0;
let errorEvents = 0;
let truncatedEvents = 0;

for (const { filePath } of sample) {
  let primary: DecodeResult;
  try {
    primary = decodeFile(filePath);
  } catch {
    primaryReadFailures++;
    unclassifiable++;
    continue;
  }

  if (primary.nonEmptyLines > 0 && primary.envelopes.length === 0) {
    skippedLines += primary.skippedLines;
    if (primary.skippedLines > 0) filesWithSkippedLines++;
    unclassifiable++;
    continue;
  }

  let envelopes = primary.envelopes;
  let fileSkippedLines = primary.skippedLines;
  const sidecarPath = deltaSidecarPathFor(filePath);
  if (fs.existsSync(sidecarPath)) {
    sidecarsFound++;
    try {
      const sidecar = decodeFile(sidecarPath);
      envelopes = [...envelopes, ...sidecar.envelopes].sort((a, b) => a.seq - b.seq);
      fileSkippedLines += sidecar.skippedLines;
    } catch {
      // This matches the production reader's canonical-log fallback, while the
      // aggregate makes the degraded evidence visible.
      sidecarReadFailures++;
    }
  }

  skippedLines += fileSkippedLines;
  if (fileSkippedLines > 0) filesWithSkippedLines++;
  totalEnvelopes += envelopes.length;

  const audit = auditSessionLog(envelopes);
  outcomeCounts[audit.outcome]++;
  classified++;
  userTurns += audit.userTurns;
  assistantTurns += audit.assistantTurns;
  toolStarted += audit.toolCalls.started;
  toolCompleted += audit.toolCalls.completed;
  toolFailed += audit.toolCalls.failed;
  toolAborted += audit.toolCalls.aborted;
  toolUnknown += audit.toolCalls.unknown;
  unfinishedToolCalls += audit.unfinishedToolCalls.length;
  unfinishedSubagents += audit.unfinishedSubagents.length;
  unfinishedBackgroundShells += audit.unfinishedBackgroundShells.length;
  errorEvents += audit.errors.length;
  truncatedEvents += audit.truncatedEvents;
}

const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
const result = {
  sampledFiles: sample.length,
  classified,
  unclassifiable,
  failures: {
    directoryRead: directoryReadFailures,
    candidateStat: candidateStatFailures,
    primaryRead: primaryReadFailures,
    sidecarRead: sidecarReadFailures,
    sidecarsFound,
  },
  decodeQuality: { filesWithSkippedLines, skippedLines, totalEnvelopes },
  outcomes: outcomeCounts,
  aggregates: {
    userTurns,
    assistantTurns,
    toolCalls: {
      started: toolStarted,
      completed: toolCompleted,
      failed: toolFailed,
      aborted: toolAborted,
      unknown: toolUnknown,
      unfinished: unfinishedToolCalls,
    },
    unfinishedSubagents,
    unfinishedBackgroundShells,
    errorEvents,
    truncatedEvents,
  },
  elapsedMs: Number(elapsedMs.toFixed(3)),
};

process.stdout.write(`${JSON.stringify(result)}\n`);
