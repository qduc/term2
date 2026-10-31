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
 */

import type { Fact } from './facts.js';

export interface ConversationLog {
  readonly path: string;
  append(facts: readonly Fact[]): void;
  close(): void;
}

/** Opens `<dir>/<id>.jsonl` with 'wx'. The directory refusal (D9) happens in app before this. */
export function createLog(_dir: string, _id: string): ConversationLog {
  throw new Error('createLog is not implemented yet (M1 task 2)');
}

/** Truncates a torn final line and continues the seq. */
export function openLog(_path: string): ConversationLog {
  throw new Error('openLog is not implemented yet (M1 task 2)');
}

/** Pure read; never writes. */
export function readFacts(_path: string): readonly Fact[] {
  throw new Error('readFacts is not implemented yet (M1 task 2)');
}
