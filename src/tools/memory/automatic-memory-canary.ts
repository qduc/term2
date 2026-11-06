import { createHash } from 'node:crypto';
import type { CreateMemoryInput } from './memory-store.js';
import { containsSecret } from './distiller/secret-redaction.js';

export type AutomaticMemoryReceipt = {
  scope: 'project';
  id: string;
  quote: string;
  sourceSessionId: string;
  undo: string;
};

type CanaryStore = {
  createAutomatic(input: CreateMemoryInput, sourceSessionId: string): Promise<unknown | null>;
};

const PREFERENCE =
  /^(?:Remember for future sessions: I prefer |For future sessions, I prefer )[a-zA-Z][^\r\n`"'<>]*\.$/;

/** Deliberately narrow live pilot: no model call and no inferred or corrected claims. */
export class AutomaticMemoryCanary {
  readonly #writtenSessions = new Set<string>();
  #stopped = false;
  constructor(private readonly store: CanaryStore) {}

  async record(text: string, sourceSessionId: string): Promise<AutomaticMemoryReceipt | null> {
    if (
      this.#stopped ||
      this.#writtenSessions.has(sourceSessionId) ||
      !sourceSessionId ||
      text.length > 280 ||
      !PREFERENCE.test(text) ||
      /\b(?:for this task|for now|just this time|temporarily|today|this session|this one time)\b/i.test(text) ||
      containsSecret(text)
    )
      return null;

    const id = `automatic-${createHash('sha256').update(text).digest('hex').slice(0, 32)}`;
    let created: unknown | null;
    try {
      created = await this.store.createAutomatic(
        { id, title: text, summary: text, content: text, tags: ['preference', 'automatic-canary'] },
        sourceSessionId,
      );
    } catch (error) {
      this.#stopped = true;
      throw error;
    }
    if (!created) return null;
    this.#writtenSessions.add(sourceSessionId);
    return { scope: 'project', id, quote: text, sourceSessionId, undo: `memory_delete({scope:"project",id:"${id}"})` };
  }
}
