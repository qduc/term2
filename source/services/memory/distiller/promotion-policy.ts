import type { CreateMemoryInput } from '../memory-store.js';
import { containsSecret } from './secret-redaction.js';

type Record = { sourceIndex: number; role: string; text: string };
type Lead = { sourceIndex: number; quote: string; category: string };
type Evidence = { sourceIndex: number; quote: string };
type Decision =
  | { status: 'rejected' | 'noop' }
  | { status: 'eligible' | 'candidate'; memory: CreateMemoryInput; evidence: Evidence };

/** The model selects a lead; it never authors text that can become a memory. */
export function validateDistilledOperation(
  value: unknown,
  records: readonly Record[],
  leads: readonly Lead[],
): Decision {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { status: 'rejected' };
  const raw = value as { [key: string]: unknown };
  if (raw.op === 'noop') return { status: 'noop' };
  if (
    raw.op !== 'create' ||
    raw.scope !== 'project' ||
    typeof raw.id !== 'string' ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(raw.id) ||
    !['preference', 'decision', 'correction', 'reference'].includes(raw.kind as string) ||
    !Array.isArray(raw.evidence) ||
    raw.evidence.length !== 1
  )
    return { status: 'rejected' };
  const evidence = raw.evidence[0] as Partial<Evidence> | null;
  if (
    !evidence ||
    !Number.isSafeInteger(evidence.sourceIndex) ||
    typeof evidence.quote !== 'string' ||
    evidence.quote.length === 0 ||
    evidence.quote.length > 280 ||
    evidence.quote.includes('[REDACTED]') ||
    containsSecret(evidence.quote) ||
    !records.some(
      (record) =>
        record.role === 'user' && record.sourceIndex === evidence.sourceIndex && record.text === evidence.quote,
    )
  )
    return { status: 'rejected' };

  const quote = evidence.quote;
  const lead = leads.find((candidate) => candidate.sourceIndex === evidence.sourceIndex && candidate.quote === quote);
  const memory = { id: raw.id, title: quote, summary: quote, content: quote, tags: [raw.kind as string] };
  return {
    status:
      lead?.category === 'preference' &&
      raw.kind === 'preference' &&
      !/\b(?:for this task|for now|just this time|temporarily|today|this session|this one time)\b/i.test(quote)
        ? 'eligible'
        : 'candidate',
    memory,
    evidence: { sourceIndex: evidence.sourceIndex!, quote },
  };
}
