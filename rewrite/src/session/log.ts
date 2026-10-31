/**
 * The conversation log file. One writer, one JSONL line per fact.
 *
 * `append` writes the whole buffer in one operation, finishing short writes,
 * and fsyncs unless every fact is `text_delta`. If it throws, the log is dead:
 * no later append may run, because a short write leaves an unterminated line
 * that another write would glue onto.
 *
 * `readFacts` tolerates only an unterminated final line. An unknown version, an
 * unknown fact type, a bad interior line or a seq gap throws.
 *
 * A fact is one *terminated* line. A final line without its newline is torn,
 * even when its bytes happen to parse: `readFacts` ignores it, and the next
 * non-empty append truncates it first. Opening alone changes no bytes. That is
 * what keeps a killed process's half-line from becoming history or from
 * swallowing the next fact.
 */

import { closeSync, fsyncSync, ftruncateSync, openSync, readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';

import { LOG_FORMAT_VERSION, type Fact, type FactLine } from './facts.js';

export interface ConversationLog {
  readonly path: string;
  append(facts: readonly Fact[]): void;
  close(): void;
}

const FACT_TYPES: ReadonlySet<string> = new Set([
  'session_started',
  'turn_started',
  'text_delta',
  'item',
  'tool_started',
  'tool_finished',
  'interaction_opened',
  'interaction_closed',
  'usage',
  'turn_ended',
]);

const NEWLINE = 0x0a;

type ParsedLog = {
  readonly facts: readonly Fact[];
  readonly lastSeq: number;
  /** Byte length of the terminated lines; anything after it is a torn tail. */
  readonly complete: number;
};

const UTF8 = new TextDecoder('utf-8', { fatal: true });

/**
 * Parses every terminated line. A last line without `\n` is not a fact and is
 * only reported through `complete` and `lastSeq`, so callers can truncate it.
 */
function parseLog(data: Buffer, path: string): ParsedLog {
  if (data.length === 0) return { facts: [], lastSeq: 0, complete: 0 };

  const complete = data.lastIndexOf(NEWLINE) + 1;
  if (complete === 0) return { facts: [], lastSeq: 0, complete: 0 };

  let text: string;
  try {
    text = UTF8.decode(data.subarray(0, complete));
  } catch (error) {
    throw new Error(`${path}: invalid UTF-8 in log: ${errorMessage(error)}`, { cause: error });
  }

  const lines = text.split('\n');
  // The empty string after the final newline.
  lines.pop();

  const facts: Fact[] = [];
  let lastSeq = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const lineNumber = index + 1;
    const expectedSeq = lastSeq + 1;
    const where = `${path}:${lineNumber}`;

    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch (error) {
      throw new Error(`${where}: invalid JSON: ${errorMessage(error)}`, { cause: error });
    }
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`${where}: log line is not an object`);
    }

    const record = entry as Record<string, unknown>;
    const version = record['v'];
    if (version !== LOG_FORMAT_VERSION) {
      throw new Error(`${where}: unsupported log version ${String(version)}`);
    }

    const seq = record['seq'];
    if (typeof seq !== 'number' || !Number.isInteger(seq)) {
      throw new Error(`${where}: log sequence is not an integer`);
    }
    if (seq !== expectedSeq) {
      throw new Error(`${where}: sequence gap: expected ${expectedSeq}, found ${seq}`);
    }

    if (typeof record['at'] !== 'string') {
      throw new Error(`${where}: log timestamp is not a string`);
    }

    const fact = record['fact'];
    if (typeof fact !== 'object' || fact === null || Array.isArray(fact)) {
      throw new Error(`${where}: log fact is not an object`);
    }
    const type = (fact as Record<string, unknown>)['type'];
    if (typeof type !== 'string' || !FACT_TYPES.has(type)) {
      throw new Error(`${where}: unknown fact type ${JSON.stringify(String(type))}`);
    }

    validateFact(fact as Record<string, unknown>, where);
    facts.push(fact as Fact);
    lastSeq = seq;
  }

  return { facts, lastSeq, complete };
}

/** Validate additive direct facts without changing the v1 envelope or M1 payload rules. */
function validateFact(fact: Record<string, unknown>, where: string): void {
  const fail = (field: string): never => {
    throw new Error(`${where}: invalid ${String(fact['type'])}.${field}`);
  };
  const text = (value: unknown, field: string): void => {
    if (typeof value !== 'string' || value.length === 0) fail(field);
  };
  const optionalText = (record: Record<string, unknown>, field: string): void => {
    if (field in record) text(record[field], field);
  };
  const object = (value: unknown, field: string): Record<string, unknown> => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(field);
    return value as Record<string, unknown>;
  };
  const hasInput = (record: Record<string, unknown>): void => {
    if (!('input' in record)) fail('input');
  };
  const result = (value: unknown): void => {
    const record = object(value, 'result');
    if (typeof record['output'] !== 'string' || typeof record['isError'] !== 'boolean') fail('result');
    if ('providerOutput' in record) {
      if (!Array.isArray(record['providerOutput'])) fail('result.providerOutput');
      for (const part of record['providerOutput'] as unknown[]) object(part, 'result.providerOutput[]');
    }
  };
  const resolution = (value: unknown): void => {
    const record = object(value, 'resolution');
    switch (record['kind']) {
      case 'allow':
      case 'cancelled':
      case 'interrupted':
        break;
      case 'deny':
        if ('reason' in record && typeof record['reason'] !== 'string') fail('resolution.reason');
        break;
      case 'answer':
        if (typeof record['answer'] !== 'string') fail('resolution.answer');
        break;
      default:
        fail('resolution.kind');
    }
    if ('stopAfterApprovalResolution' in record && typeof record['stopAfterApprovalResolution'] !== 'boolean') {
      fail('resolution.stopAfterApprovalResolution');
    }
  };

  if (
    'modelStep' in fact &&
    (typeof fact['modelStep'] !== 'number' || !Number.isSafeInteger(fact['modelStep']) || fact['modelStep'] < 0)
  ) {
    fail('modelStep');
  }
  switch (fact['type']) {
    case 'item': {
      if ('executionId' in fact) {
        text(fact['executionId'], 'executionId');
        const item = object(fact['item'], 'item');
        if (item['type'] !== 'tool_call' && item['type'] !== 'tool_result') fail('executionId');
      }
      break;
    }
    case 'tool_started':
      text(fact['turnId'], 'turnId');
      text(fact['executionId'], 'executionId');
      optionalText(fact, 'parentExecutionId');
      if (fact['parentExecutionId'] === fact['executionId']) fail('parentExecutionId');
      text(fact['callId'], 'callId');
      text(fact['toolName'], 'toolName');
      hasInput(fact);
      break;
    case 'tool_finished':
      text(fact['turnId'], 'turnId');
      text(fact['executionId'], 'executionId');
      result(fact['result']);
      break;
    case 'interaction_opened': {
      text(fact['turnId'], 'turnId');
      const request = object(fact['request'], 'request');
      text(request['requestId'], 'request.requestId');
      text(request['turnId'], 'request.turnId');
      if (request['turnId'] !== fact['turnId']) fail('request.turnId');
      if (request['kind'] !== 'approval' && request['kind'] !== 'question') fail('request.kind');
      text(request['toolName'], 'request.toolName');
      if (typeof request['summary'] !== 'string') fail('request.summary');
      if ('detail' in request && typeof request['detail'] !== 'string') fail('request.detail');
      optionalText(request, 'executionId');
      optionalText(request, 'parentExecutionId');
      optionalText(request, 'sourceCallId');
      if (
        'risk' in request &&
        request['risk'] !== 'low' &&
        request['risk'] !== 'medium' &&
        request['risk'] !== 'high'
      ) {
        fail('request.risk');
      }
      if ('presentation' in request) object(request['presentation'], 'request.presentation');
      hasInput(request);
      break;
    }
    case 'interaction_closed':
      text(fact['turnId'], 'turnId');
      text(fact['requestId'], 'requestId');
      resolution(fact['resolution']);
      break;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createConversationLog(path: string, fd: number, firstSeq: number, tornFrom?: number): ConversationLog {
  let sequence = firstSeq;
  let handle: number | null = fd;
  let dead = false;
  let pendingTruncate = tornFrom;

  return {
    path,

    append(facts: readonly Fact[]): void {
      if (dead) {
        throw new Error(`conversation log ${path} is unusable after an earlier write failure`);
      }
      if (handle === null) {
        throw new Error(`conversation log ${path} is closed`);
      }
      if (facts.length === 0) return;

      const fd = handle;

      try {
        const lines = facts.map((fact) => {
          const line: FactLine = {
            v: LOG_FORMAT_VERSION,
            seq: sequence,
            at: new Date().toISOString(),
            fact,
          };
          sequence += 1;
          return `${JSON.stringify(line)}\n`;
        });
        const buffer = Buffer.from(lines.join(''), 'utf8');
        if (pendingTruncate !== undefined) {
          ftruncateSync(fd, pendingTruncate);
          pendingTruncate = undefined;
        }
        let offset = 0;
        while (offset < buffer.length) {
          const written = writeSync(fd, buffer, offset, buffer.length - offset);
          if (written <= 0) {
            throw new Error(`short write: wrote ${written} of ${buffer.length - offset} bytes`);
          }
          offset += written;
        }
        // Deltas may be lost on power failure; every other fact may not.
        if (!facts.every((fact) => fact.type === 'text_delta')) {
          fsyncSync(fd);
        }
      } catch (error) {
        dead = true;
        handle = null;
        try {
          closeSync(fd);
        } catch {
          // The write failure is the one worth reporting.
        }
        throw new Error(`conversation log ${path} write failed: ${errorMessage(error)}`, { cause: error });
      }
    },

    close(): void {
      if (handle === null) return;
      const fd = handle;
      handle = null;
      closeSync(fd);
    },
  };
}

/** Opens `<dir>/<id>.jsonl` with 'wx'. The directory refusal (D9) happens in app before this. */
export function createLog(dir: string, id: string): ConversationLog {
  const path = join(dir, `${id}.jsonl`);
  return createConversationLog(path, openSync(path, 'wx'), 1);
}

/** Changes no bytes: continues the seq, and leaves a torn final line for the next append to remove. */
export function openLog(path: string): ConversationLog {
  const data = readFileSync(path);
  const { lastSeq, complete } = parseLog(data, path);
  // Append mode: after the truncate, writes land at the new end without a position.
  return createConversationLog(path, openSync(path, 'a'), lastSeq + 1, complete !== data.length ? complete : undefined);
}

/** Pure read; never writes. */
export function readFacts(path: string): readonly Fact[] {
  return parseLog(readFileSync(path), path).facts;
}
