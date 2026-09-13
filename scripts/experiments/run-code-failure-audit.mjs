#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const home = process.env.HOME;
const logDir = join(home, '.local/state/term2-nodejs/logs');
const conversationDir = join(home, '.local/share/term2-nodejs/conversations');
const dates = process.argv.slice(2);
const before = process.env.RUN_CODE_AUDIT_BEFORE
  ? Date.parse(process.env.RUN_CODE_AUDIT_BEFORE)
  : Number.POSITIVE_INFINITY;

if (dates.length === 0) {
  console.error('Usage: node scripts/experiments/run-code-failure-audit.mjs YYYY-MM-DD [...]');
  process.exitCode = 2;
} else {
  const telemetry = dates.flatMap((date) =>
    readJsonLines(join(logDir, `term2-${date}.log`))
      .map(({ value }) => value)
      .filter((value) => value.eventType === 'tool.run_code.completion' && Date.parse(value.timestamp) < before),
  );

  const sessions = new Map();
  for (const completion of telemetry) {
    if (!sessions.has(completion.sessionId)) {
      sessions.set(completion.sessionId, readConversation(completion.sessionId));
    }
  }

  const completionQueues = new Map();
  for (const completion of telemetry) {
    const key = `${completion.sessionId}:${completion.sourceDigest}`;
    const queue = completionQueues.get(key) ?? [];
    queue.push(completion);
    completionQueues.set(key, queue);
  }

  for (const session of sessions.values()) {
    for (const invocation of session.invocations) {
      const key = `${session.sessionId}:${invocation.sourceDigest}`;
      invocation.completion = completionQueues.get(key)?.shift() ?? null;
    }
  }

  const failures = [];
  const matchedInvocations = [];
  for (const session of sessions.values()) {
    for (let index = 0; index < session.invocations.length; index += 1) {
      const invocation = session.invocations[index];
      if (invocation.completion) {
        matchedInvocations.push({
          outcome: invocation.completion.outcome,
          sourceForm: classifySourceForm(invocation.code),
        });
      }
      if (!invocation.completion || invocation.completion.outcome === 'success') continue;
      const next = session.invocations.slice(index + 1).find((candidate) => candidate.completion);
      failures.push({
        sessionId: session.sessionId,
        provenance: classifyProvenance(session.firstUserText),
        date: invocation.ts.slice(0, 10),
        startedLine: invocation.line,
        resultLine: invocation.resultLine,
        callId: invocation.callId,
        description: invocation.description,
        sourceBytes: invocation.completion.sourceBytes,
        outcome: invocation.completion.outcome,
        failureClass: invocation.completion.failureClass ?? null,
        sourceForm: classifySourceForm(invocation.code),
        parseCause:
          invocation.completion.outcome === 'parse' ? classifyParse(invocation.code, invocation.output) : null,
        runtimeCause: invocation.completion.outcome === 'runtime' ? classifyRuntime(invocation.output) : null,
        errorSummary: summarizeError(invocation.output),
        nestedCalls: invocation.completion.nested?.calls ?? 0,
        appliedEffects: invocation.completion.effectReceipts?.applied ?? 0,
        nextOutcome: next?.completion?.outcome ?? null,
        nextDelaySeconds: next ? Math.round((Date.parse(next.ts) - Date.parse(invocation.ts)) / 1000) : null,
        nextSameTurn: next ? next.turnId === invocation.turnId : null,
      });
    }
  }

  const unmatched = [...completionQueues.values()].flat().filter((completion) => completion.outcome !== 'success');

  console.log(
    JSON.stringify(
      {
        source: dates.map((date) => join(logDir, `term2-${date}.log`)),
        totals: {
          completions: telemetry.length,
          sessions: sessions.size,
          matchedFailures: failures.length,
          unmatchedFailures: unmatched.length,
        },
        aggregate: aggregateFailures(failures),
        invocationSourceForms: Object.fromEntries(
          [...groupBy(matchedInvocations, (invocation) => invocation.sourceForm)].map(([key, group]) => [
            key,
            {
              total: group.length,
              failures: group.filter((invocation) => invocation.outcome !== 'success').length,
              parseFailures: group.filter((invocation) => invocation.outcome === 'parse').length,
            },
          ]),
        ),
        unmatched: unmatched.map((completion) => ({
          timestamp: completion.timestamp,
          sessionId: completion.sessionId,
          sourceDigest: completion.sourceDigest,
          outcome: completion.outcome,
          failureClass: completion.failureClass ?? null,
        })),
        failures,
      },
      null,
      2,
    ),
  );
}

function readConversation(sessionId) {
  const path = join(conversationDir, `${sessionId}.jsonl`);
  let records;
  try {
    records = readJsonLines(path);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { sessionId, path, firstUserText: '', invocations: [] };
    }
    throw error;
  }

  const results = new Map();
  for (const { value, line } of records) {
    if (value.event?.type === 'tool_result' && value.event.toolName === 'run_code') {
      results.set(value.event.callId, { output: value.event.output, line });
    }
    const journalItem = value.event?.type === 'assistant_journal_item' ? value.event.item : null;
    if (journalItem?.type === 'tool_result' && journalItem.toolName === 'run_code') {
      results.set(journalItem.callId, { output: journalItem.output, line });
    }
  }

  const firstUser = records.find(({ value }) => value.event?.type === 'user_message');
  const firstUserText = firstUser?.value.event.message?.text ?? '';
  const invocations = records
    .filter(({ value }) => value.event?.type === 'tool_started' && value.event.toolName === 'run_code')
    .map(({ value, line }) => {
      const code = value.event.arguments?.code ?? '';
      const result = results.get(value.event.toolCallId);
      return {
        callId: value.event.toolCallId,
        turnId: value.event.turnId,
        ts: value.ts,
        line,
        resultLine: result?.line ?? null,
        code,
        description: value.event.arguments?.description ?? '',
        output: result?.output ?? '',
        sourceDigest: createHash('sha256').update(code).digest('hex').slice(0, 16),
        completion: null,
      };
    });

  return { sessionId, path, firstUserText, invocations };
}

function readJsonLines(path) {
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((text, index) => ({ text, line: index + 1 }))
    .filter(({ text }) => text.trim() !== '')
    .map(({ text, line }) => ({ value: JSON.parse(text), line }));
}

function classifyProvenance(text) {
  const normalized = text.toLowerCase();
  if (/benchmark|experiment|measurement|audit|review/.test(normalized)) return 'analysis-or-evaluation';
  if (/execute only that assignment|task id|provider\/model route/.test(normalized)) return 'delegated-engineering';
  return 'interactive-or-other';
}

function classifyParse(code, output) {
  if (classifySourceForm(code).startsWith('embedded-edit-')) return 'embedded-edit-literal';
  if (/dynamic import|import.*not available/i.test(output)) return 'unsupported-import';
  if (/Unexpected end of input|unterminated|Invalid or unexpected token/i.test(output)) {
    return 'truncated-or-unclosed-source';
  }
  if (/already been declared/i.test(output)) return 'duplicate-declaration';
  return 'other-javascript-syntax';
}

function classifySourceForm(code) {
  if (/tools\.(?:apply_patch|create_file|search_replace)/.test(code) && /(?:String\.raw)?`/.test(code)) {
    return 'embedded-edit-template';
  }
  if (
    /tools\.(?:apply_patch|create_file|search_replace)/.test(code) &&
    /(?:const|let|var)\s+\w+\s*=\s*['"]/.test(code)
  ) {
    return 'embedded-edit-quoted-string';
  }
  if (/tools\.(?:apply_patch|create_file|search_replace)/.test(code)) return 'edit-script';
  return 'non-edit-script';
}

function classifyRuntime(output) {
  if (
    /Cannot read propert|Cannot convert undefined|undefined.*(?:split|slice|map|content)|is not a function/i.test(
      output,
    )
  ) {
    return 'result-shape-assumption';
  }
  if (/JSON-safe|serializ|circular|return value/i.test(output)) return 'return-serialization';
  if (/not defined/i.test(output)) return 'undefined-binding';
  return 'other-runtime';
}

function summarizeError(output) {
  const line = String(output)
    .split('\n')
    .find((candidate) => /Script failed|Unknown tool|Invalid parameters|Error:/i.test(candidate));
  return (line ?? String(output).split('\n')[0] ?? '').replace(/\s+/g, ' ').slice(0, 240);
}

function aggregateFailures(failures) {
  return {
    outcomes: countBy(failures, (failure) => failure.outcome),
    failureClasses: countBy(
      failures.filter((failure) => failure.failureClass),
      (failure) => failure.failureClass,
    ),
    parseCauses: countBy(
      failures.filter((failure) => failure.parseCause),
      (failure) => failure.parseCause,
    ),
    runtimeCauses: countBy(
      failures.filter((failure) => failure.runtimeCause),
      (failure) => failure.runtimeCause,
    ),
    provenance: countBy(failures, (failure) => failure.provenance),
    nextOutcome: countBy(failures, (failure) => failure.nextOutcome ?? 'none'),
    nextSameTurn: countBy(failures, (failure) => String(failure.nextSameTurn)),
    appliedEffects: failures.filter((failure) => failure.appliedEffects > 0).length,
    recoveryDelaySeconds: summarizeNumbers(failures.map((failure) => failure.nextDelaySeconds).filter(Number.isFinite)),
  };
}

function countBy(values, keyOf) {
  return Object.fromEntries([...groupBy(values, keyOf)].map(([key, group]) => [key, group.length]));
}

function groupBy(values, keyOf) {
  const groups = new Map();
  for (const value of values) {
    const key = keyOf(value);
    const group = groups.get(key) ?? [];
    group.push(value);
    groups.set(key, group);
  }
  return groups;
}

function summarizeNumbers(values) {
  if (values.length === 0) return { count: 0, median: null, p90: null, max: null };
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    median: sorted[Math.floor((sorted.length - 1) * 0.5)],
    p90: sorted[Math.floor((sorted.length - 1) * 0.9)],
    max: sorted.at(-1),
  };
}
